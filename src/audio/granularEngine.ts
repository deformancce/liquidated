import * as Tone from "tone";

export interface GranularEngineSettings {
  grainSize: number;
  overlap: number;
  playbackRate: number;
  detune: number;
  reverse: boolean;
  position: number;
  positionJitter: number;
  density: number;
  pitchRandom: number;
  ampRandom: number;
}

const DEFAULT_SETTINGS: GranularEngineSettings = {
  grainSize: 0.12,
  overlap: 0.06,
  playbackRate: 1,
  detune: 0,
  reverse: false,
  position: 0.5,
  positionJitter: 0.12,
  density: 18,
  pitchRandom: 0,
  ampRandom: 0.15,
};

export class GranularEngine extends Tone.ToneAudioNode {
  readonly name = "GranularEngine";
  readonly input = undefined;
  readonly output = new Tone.Gain(1);
  private buffer: Tone.ToneAudioBuffer | null = null;
  private reversedBuffer: Tone.ToneAudioBuffer | null = null;
  private settings: GranularEngineSettings = { ...DEFAULT_SETTINGS };
  private loopId = 0;
  private playing = false;

  load(buffer: AudioBuffer | Tone.ToneAudioBuffer): void {
    const audioBuffer = buffer instanceof Tone.ToneAudioBuffer ? buffer.get() : buffer;
    if (!audioBuffer) return;
    this.buffer?.dispose();
    this.reversedBuffer?.dispose();
    this.buffer = new Tone.ToneAudioBuffer(audioBuffer);
    this.reversedBuffer = new Tone.ToneAudioBuffer(this.createReversedBuffer(audioBuffer));
  }

  setSettings(settings: Partial<GranularEngineSettings>): void {
    this.settings = { ...this.settings, ...settings };
  }

  start(): this {
    if (this.playing) return this;
    this.playing = true;
    this.scheduleNext();
    return this;
  }

  stop(): this {
    this.playing = false;
    window.clearTimeout(this.loopId);
    return this;
  }

  restart(): this {
    this.stop();
    this.start();
    return this;
  }

  dispose(): this {
    this.stop();
    this.output.dispose();
    this.buffer?.dispose();
    this.reversedBuffer?.dispose();
    this.buffer = null;
    this.reversedBuffer = null;
    return super.dispose();
  }

  private scheduleNext(): void {
    if (!this.playing) return;
    this.triggerGrain(Tone.now() + 0.015);
    const interval = Math.max(0.006, 1 / Math.max(1, this.settings.density));
    this.loopId = window.setTimeout(() => this.scheduleNext(), interval * 1000);
  }

  private triggerGrain(time: number): void {
    const activeBuffer = this.settings.reverse ? this.reversedBuffer : this.buffer;
    if (!activeBuffer?.loaded || !activeBuffer.get()) return;

    const duration = Math.max(0.008, this.settings.grainSize);
    const fade = Math.min(duration * 0.48, Math.max(0.002, this.settings.overlap));
    const source = new Tone.ToneBufferSource(activeBuffer);
    source.fadeIn = fade;
    source.fadeOut = fade;
    source.playbackRate.value = this.effectivePlaybackRate();
    const gain = new Tone.Gain(this.randomGain());
    const offset = this.grainOffset(duration);

    source.connect(gain).connect(this.output);
    source.start(time, offset, duration);
    source.stop(time + duration + 0.01);
    window.setTimeout(() => {
      source.dispose();
      gain.dispose();
    }, (duration + 0.25) * 1000);
  }

  private effectivePlaybackRate(): number {
    const detuneRatio = Math.pow(2, this.settings.detune / 1200);
    const randomCents = (Math.random() * 2 - 1) * this.settings.pitchRandom;
    const randomRatio = Math.pow(2, randomCents / 1200);
    return Math.max(0.025, this.settings.playbackRate * detuneRatio * randomRatio);
  }

  private randomGain(): number {
    const spread = this.settings.ampRandom;
    return Math.max(0, 1 - spread + Math.random() * spread);
  }

  private grainOffset(duration: number): number {
    const bufferDuration = this.buffer?.duration ?? 0;
    const usableDuration = Math.max(0, bufferDuration - duration);
    const jitter = (Math.random() * 2 - 1) * this.settings.positionJitter;
    const normalized = Math.max(0, Math.min(1, this.settings.position + jitter));
    return normalized * usableDuration;
  }

  private createReversedBuffer(source: AudioBuffer): AudioBuffer {
    const context = Tone.getContext();
    const reversed = context.createBuffer(source.numberOfChannels, source.length, source.sampleRate);
    for (let channel = 0; channel < source.numberOfChannels; channel += 1) {
      const input = source.getChannelData(channel);
      const output = reversed.getChannelData(channel);
      for (let index = 0; index < input.length; index += 1) {
        output[index] = input[input.length - 1 - index];
      }
    }
    return reversed;
  }
}
