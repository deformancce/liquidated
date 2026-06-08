export type RingsDspStatus =
  | { available: true; url: string }
  | { available: false; reason: string };

type EmscriptenModule = {
  HEAPF32: Float32Array;
  _malloc(size: number): number;
  _free(ptr: number): void;
  _rings_init(sampleRate: number): void;
  _rings_set_patch(frequency: number, structure: number, brightness: number, damping: number, position: number): void;
  _rings_set_mods(frequencyCv: number, structureCv: number, brightnessCv: number, dampingCv: number, positionCv: number): void;
  _rings_set_model(model: number): void;
  _rings_strum(vOct: number, velocity: number, trigger: number, exciter: number): void;
  _rings_process(inputPtr: number, oddPtr: number, evenPtr: number, frames: number): void;
};

type RingsFactory = (options?: { locateFile?: (path: string) => string }) => Promise<EmscriptenModule>;

declare global {
  interface Window {
    CreateRingsDsp?: RingsFactory;
  }
}

let loaderPromise: Promise<RingsFactory> | null = null;

export async function detectRingsDsp(): Promise<RingsDspStatus> {
  const url = "/rings/rings-dsp.js";
  try {
    const response = await fetch(url, { method: "HEAD", cache: "no-store" });
    if (response.ok) return { available: true, url };
  } catch {
    // The prototype remains usable when the WASM build is not present.
  }
  return {
    available: false,
    reason: "Original Rings WASM not built yet; using Tone modal fallback.",
  };
}

export class RingsWasmVoice {
  private ctx: AudioContext | null = null;
  private module: EmscriptenModule | null = null;
  private reverb: ConvolverNode | null = null;
  private reverbOut: GainNode | null = null;
  private inputPtr = 0;
  private oddPtr = 0;
  private evenPtr = 0;
  private allocatedFrames = 0;

  async init() {
    if (this.module) return;
    const factory = await loadFactory();
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.module = await factory({ locateFile: (path) => `/rings/${path}` });
    this.module._rings_init(this.ctx.sampleRate);
    this.initReverb();
  }

  async resume() {
    await this.init();
    const ctx = this.ctx;
    if (ctx && ctx.state !== "running") await ctx.resume();
  }

  setPatch(params: {
    frequency: number;
    structure: number;
    brightness: number;
    damping: number;
    position: number;
    frequencyCv: number;
    structureCv: number;
    brightnessCv: number;
    dampingCv: number;
    positionCv: number;
    mode: "modal" | "sympathetic" | "string";
  }) {
    if (!this.module) return;
    this.module._rings_set_patch(params.frequency, params.structure, params.brightness, params.damping, params.position);
    this.module._rings_set_mods(
      params.frequencyCv,
      params.structureCv,
      params.brightnessCv,
      params.dampingCv,
      params.positionCv,
    );
    this.module._rings_set_model(modeToRingsModel(params.mode));
  }

  strum(options: {
    output: "odd" | "even" | "mix";
    vOct: number;
    velocity: number;
    exciter: number;
    duration: number;
    attack: number;
    decay: number;
    sustain: number;
    release: number;
    oddGain?: number;
    evenGain?: number;
  }) {
    if (!this.module || !this.ctx) return { odd: 0, even: 0, stop: () => {} };
    const renderDuration = Math.max(options.duration, minEnvelopeDuration(options));
    const frames = Math.max(256, Math.floor(this.ctx.sampleRate * renderDuration));
    this.ensureBuffers(frames);
    const input = this.module.HEAPF32.subarray(this.inputPtr >> 2, (this.inputPtr >> 2) + frames);
    input.fill(0);
    this.module._rings_strum(options.vOct, options.velocity, 1, options.exciter);
    this.module._rings_process(this.inputPtr, this.oddPtr, this.evenPtr, frames);

    const odd = this.module.HEAPF32.slice(this.oddPtr >> 2, (this.oddPtr >> 2) + frames);
    const even = this.module.HEAPF32.slice(this.evenPtr >> 2, (this.evenPtr >> 2) + frames);
    const buffer = this.ctx.createBuffer(2, frames, this.ctx.sampleRate);
    const left = buffer.getChannelData(0);
    const right = buffer.getChannelData(1);
    let oddPeak = 0;
    let evenPeak = 0;
    const oddGain = options.oddGain ?? 1;
    const evenGain = options.evenGain ?? 1;
    const envelope = { ...options, duration: renderDuration };
    for (let i = 0; i < frames; i += 1) {
      const time = i / this.ctx.sampleRate;
      const amp = adsrAt(time, envelope) * edgeFade(i, frames);
      const o = odd[i] * 0.9 * oddGain * amp;
      const e = even[i] * 0.9 * evenGain * amp;
      oddPeak = Math.max(oddPeak, Math.abs(o));
      evenPeak = Math.max(evenPeak, Math.abs(e));
      if (options.output === "odd") {
        left[i] = o;
        right[i] = o;
      } else if (options.output === "even") {
        left[i] = e;
        right[i] = e;
      } else {
        left[i] = o;
        right[i] = e;
      }
    }
    const source = this.ctx.createBufferSource();
    const gain = this.ctx.createGain();
    const send = this.ctx.createGain();
    source.buffer = buffer;
    source.connect(gain);
    source.connect(send);
    gain.connect(this.ctx.destination);
    if (this.reverb) send.connect(this.reverb);
    send.gain.value = 0.18;
    source.addEventListener("ended", () => {
      source.disconnect();
      gain.disconnect();
      send.disconnect();
    }, { once: true });
    source.start();
    return {
      odd: Math.min(1, oddPeak * 8),
      even: Math.min(1, evenPeak * 8),
      stop: (fadeMs = 45) => {
        if (!this.ctx) return;
        const now = this.ctx.currentTime;
        const fadeTime = Math.max(0.005, fadeMs / 1000);
        gain.gain.cancelScheduledValues(now);
        gain.gain.setValueAtTime(gain.gain.value, now);
        gain.gain.linearRampToValueAtTime(0, now + fadeTime);
        send.gain.cancelScheduledValues(now);
        send.gain.setValueAtTime(send.gain.value, now);
        send.gain.linearRampToValueAtTime(0, now + fadeTime);
        source.stop(now + fadeTime + 0.01);
      },
    };
  }

  dispose() {
    if (this.module) {
      if (this.inputPtr) this.module._free(this.inputPtr);
      if (this.oddPtr) this.module._free(this.oddPtr);
      if (this.evenPtr) this.module._free(this.evenPtr);
    }
    void this.ctx?.close();
  }

  private initReverb() {
    if (!this.ctx || this.reverb) return;
    this.reverb = this.ctx.createConvolver();
    this.reverb.buffer = createImpulse(this.ctx, 2.6, 2.8);
    this.reverbOut = this.ctx.createGain();
    this.reverbOut.gain.value = 0.32;
    this.reverb.connect(this.reverbOut);
    this.reverbOut.connect(this.ctx.destination);
  }

  private ensureBuffers(frames: number) {
    if (!this.module || frames <= this.allocatedFrames) return;
    if (this.inputPtr) this.module._free(this.inputPtr);
    if (this.oddPtr) this.module._free(this.oddPtr);
    if (this.evenPtr) this.module._free(this.evenPtr);
    const bytes = frames * Float32Array.BYTES_PER_ELEMENT;
    this.inputPtr = this.module._malloc(bytes);
    this.oddPtr = this.module._malloc(bytes);
    this.evenPtr = this.module._malloc(bytes);
    this.allocatedFrames = frames;
  }
}

async function loadFactory() {
  if (window.CreateRingsDsp) return window.CreateRingsDsp;
  loaderPromise ??= new Promise<RingsFactory>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/rings/rings-dsp.js";
    script.async = true;
    script.onload = () => {
      if (window.CreateRingsDsp) resolve(window.CreateRingsDsp);
      else reject(new Error("CreateRingsDsp did not register"));
    };
    script.onerror = () => reject(new Error("Failed to load Rings WASM loader"));
    document.head.appendChild(script);
  });
  return loaderPromise;
}

function createImpulse(ctx: AudioContext, seconds: number, decay: number) {
  const length = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const impulse = ctx.createBuffer(2, length, ctx.sampleRate);
  for (let channel = 0; channel < impulse.numberOfChannels; channel += 1) {
    const data = impulse.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      const t = i / length;
      const envelope = Math.pow(1 - t, decay);
      data[i] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return impulse;
}

function modeToRingsModel(mode: "modal" | "sympathetic" | "string") {
  if (mode === "sympathetic") return 1;
  if (mode === "string") return 2;
  return 0;
}

function adsrAt(
  time: number,
  envelope: { attack: number; decay: number; sustain: number; release: number; duration: number },
) {
  const attack = Math.max(0.001, envelope.attack);
  const decay = Math.max(0.001, envelope.decay);
  const release = Math.max(0.001, envelope.release);
  const sustain = Math.max(0, Math.min(1, envelope.sustain));
  const releaseStart = Math.max(attack + decay, envelope.duration - release);

  if (time < attack) return time / attack;
  if (time < attack + decay) {
    const phase = (time - attack) / decay;
    return 1 + (sustain - 1) * phase;
  }
  if (time < releaseStart) return sustain;
  const phase = Math.min(1, (time - releaseStart) / release);
  return sustain * (1 - phase);
}

function minEnvelopeDuration(envelope: { attack: number; decay: number; release: number }) {
  return Math.max(0.02, envelope.attack) + Math.max(0.02, envelope.decay) + Math.max(0.02, envelope.release) + 0.03;
}

function edgeFade(index: number, frames: number) {
  const fadeFrames = Math.min(Math.floor(frames / 2), 256);
  if (fadeFrames <= 1) return 1;
  const fadeIn = Math.min(1, index / fadeFrames);
  const fadeOut = Math.min(1, (frames - 1 - index) / fadeFrames);
  return Math.max(0, Math.min(fadeIn, fadeOut));
}
