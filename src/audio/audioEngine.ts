import { clamp } from "../utils/format";
import type { FlowSignal, ScannerSettings, TradeEvent } from "../types";

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private delay: DelayNode | null = null;
  private feedback: GainNode | null = null;
  private fluidGain: GainNode | null = null;
  private fluidFilter: BiquadFilterNode | null = null;
  private fluidPan: StereoPannerNode | null = null;
  private enabled = false;

  async toggle(settings: ScannerSettings): Promise<boolean> {
    this.ensureContext(settings);
    if (!this.context) return false;
    if (this.context.state === "suspended") await this.context.resume();
    this.enabled = !this.enabled;
    this.setFluidLevel(this.enabled ? 0.035 : 0.0001, 0.35);
    return this.enabled;
  }

  setSettings(settings: ScannerSettings): void {
    if (this.master) this.master.gain.value = settings.volume;
    if (this.feedback) this.feedback.gain.value = settings.space * 0.42;
    if (this.fluidFilter && this.context) {
      this.fluidFilter.frequency.setTargetAtTime(220 + settings.timbre * 520, this.context.currentTime, 0.2);
      this.fluidFilter.Q.setTargetAtTime(0.8 + settings.space * 2.2, this.context.currentTime, 0.2);
    }
  }

  playTrade(trade: TradeEvent, settings: ScannerSettings): void {
    if (!this.enabled || !this.context || !this.master) return;
    const sizeTone = clamp(Math.log10(trade.size + 1), 3.5, 7);
    const intensity = clamp(trade.size / 1_200_000, 0.012, 0.18);
    this.exciteFluid(trade.side === "buy" ? -0.35 : 0.35, sizeTone, intensity, settings);
    this.playWaterPing({
      pan: trade.side === "buy" ? -0.32 : 0.32,
      sizeTone,
      intensity: intensity * 1.9,
      hollow: 0.45 + settings.timbre * 0.45,
      duration: 0.34,
      settings,
    });
  }

  playSignal(signal: FlowSignal, settings: ScannerSettings): void {
    if (!this.enabled || !this.context || !this.master) return;
    const now = this.context.currentTime;
    const isCascade = signal.type === "cascadeRisk";
    const isAbsorption = signal.type === "absorptionAsk" || signal.type === "absorptionBid";

    this.exciteFluid(signal.side === "buy" ? -0.48 : signal.side === "sell" ? 0.48 : 0, signal.intensity + 4, signal.intensity / 7, settings);
    this.playWaterPing({
      pan: signal.side === "buy" ? -0.46 : signal.side === "sell" ? 0.46 : 0,
      sizeTone: signal.intensity + 4.2,
      intensity: clamp(signal.intensity / 4.5, 0.18, isCascade ? 1.4 : 0.85),
      hollow: isAbsorption ? 0.25 : 0.7,
      duration: isCascade ? 0.82 : isAbsorption ? 0.52 : 0.42,
      settings,
      cascade: isCascade,
    });

    if (isCascade) {
      this.playCascadeWash(settings, now, signal.side === "buy" ? -0.2 : signal.side === "sell" ? 0.2 : 0, signal.intensity);
    }
  }

  private ensureContext(settings: ScannerSettings): void {
    if (this.context) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.delay = this.context.createDelay(0.7);
    this.feedback = this.context.createGain();
    this.fluidGain = this.context.createGain();
    this.fluidFilter = this.context.createBiquadFilter();
    this.fluidPan = this.context.createStereoPanner();

    this.master.gain.value = settings.volume;
    this.delay.delayTime.value = 0.18;
    this.feedback.gain.value = settings.space * 0.42;
    this.fluidGain.gain.value = 0.0001;
    this.fluidFilter.type = "lowpass";
    this.fluidFilter.frequency.value = 260 + settings.timbre * 520;
    this.fluidFilter.Q.value = 0.8 + settings.space * 2.2;
    this.fluidPan.pan.value = 0;

    this.createFluidOscillator(61.7, "sine");
    this.createFluidOscillator(92.5, "triangle");
    this.createFluidOscillator(123.4, "sine");

    this.master.connect(this.context.destination);
    this.master.connect(this.delay);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.context.destination);
  }

  private createFluidOscillator(frequency: number, type: OscillatorType): void {
    if (!this.context || !this.fluidGain || !this.fluidFilter || !this.fluidPan || !this.master) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.value = frequency;
    gain.gain.value = type === "triangle" ? 0.32 : 0.22;
    oscillator.connect(gain).connect(this.fluidFilter);
    oscillator.start();
    this.fluidFilter.connect(this.fluidGain).connect(this.fluidPan).connect(this.master);
  }

  private playWaterPing(input: {
    pan: number;
    sizeTone: number;
    intensity: number;
    hollow: number;
    duration: number;
    settings: ScannerSettings;
    cascade?: boolean;
  }): void {
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    const random = Math.random();
    const noise = this.context.createBufferSource();
    const noiseBuffer = this.context.createBuffer(1, Math.floor(this.context.sampleRate * 0.035), this.context.sampleRate);
    const samples = noiseBuffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = (Math.random() * 2 - 1) * Math.exp(-index / (samples.length * 0.18));
    }
    noise.buffer = noiseBuffer;

    const pingA = this.context.createBiquadFilter();
    const pingB = this.context.createBiquadFilter();
    const highpass = this.context.createBiquadFilter();
    const body = this.context.createOscillator();
    const bodyGain = this.context.createGain();
    const gain = this.context.createGain();
    const pan = this.context.createStereoPanner();

    const base = 470 + input.sizeTone * 105 + input.settings.timbre * 420 + random * 140;
    const top = base * (1.72 + input.hollow * 0.42);
    const amount = clamp(input.intensity, 0.04, input.cascade ? 1.4 : 0.8);
    const duration = input.duration + random * 0.06;

    highpass.type = "highpass";
    highpass.frequency.value = 160;
    pingA.type = "bandpass";
    pingB.type = "bandpass";
    pingA.Q.value = 18 + input.hollow * 16;
    pingB.Q.value = 10 + input.hollow * 12;
    pingA.frequency.setValueAtTime(base * 0.78, now);
    pingA.frequency.exponentialRampToValueAtTime(top, now + 0.09 + input.hollow * 0.05);
    pingA.frequency.exponentialRampToValueAtTime(base * 1.18, now + duration);
    pingB.frequency.setValueAtTime(base * 1.42, now);
    pingB.frequency.exponentialRampToValueAtTime(top * 1.26, now + 0.12);
    pingB.frequency.exponentialRampToValueAtTime(base * 1.08, now + duration);

    body.type = "sine";
    body.frequency.setValueAtTime(base * 0.46, now);
    body.frequency.exponentialRampToValueAtTime(base * 0.84, now + 0.16);
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.exponentialRampToValueAtTime(amount * 0.035, now + 0.018);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + duration * 0.86);

    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(amount * 0.18 * input.settings.cascadeIntensity, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    pan.pan.setValueAtTime(input.pan + (random - 0.5) * 0.16, now);

    noise.connect(highpass).connect(pingA).connect(pingB).connect(gain).connect(pan).connect(this.master);
    body.connect(bodyGain).connect(pan);
    noise.start(now);
    noise.stop(now + 0.05);
    body.start(now);
    body.stop(now + duration);
  }

  private playCascadeWash(settings: ScannerSettings, now: number, panValue: number, intensity: number): void {
    if (!this.context || !this.master) return;
    const noise = this.context.createBufferSource();
    const buffer = this.context.createBuffer(1, Math.floor(this.context.sampleRate * 0.55), this.context.sampleRate);
    const samples = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = (Math.random() * 2 - 1) * Math.exp(-index / (samples.length * 0.62));
    }
    noise.buffer = buffer;

    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const pan = this.context.createStereoPanner();
    filter.type = "bandpass";
    filter.frequency.setValueAtTime(280 + intensity * 80, now);
    filter.frequency.exponentialRampToValueAtTime(1200 + intensity * 160, now + 0.26);
    filter.Q.value = 2.8;
    pan.pan.value = panValue;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(clamp(intensity / 18, 0.025, 0.18) * settings.cascadeIntensity, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);

    noise.connect(filter).connect(gain).connect(pan).connect(this.master);
    noise.start(now);
    noise.stop(now + 0.7);
  }

  private exciteFluid(pan: number, tone: number, intensity: number, settings: ScannerSettings): void {
    if (!this.context || !this.fluidGain || !this.fluidFilter || !this.fluidPan) return;
    const now = this.context.currentTime;
    const lift = clamp(tone / 7, 0.35, 1.2);
    const targetGain = clamp(0.035 + intensity * 0.34, 0.035, 0.18) * settings.cascadeIntensity;
    const targetFrequency = 180 + lift * 520 + settings.timbre * 740;

    this.fluidGain.gain.cancelScheduledValues(now);
    this.fluidGain.gain.setTargetAtTime(targetGain, now, 0.045);
    this.fluidGain.gain.setTargetAtTime(this.enabled ? 0.035 : 0.0001, now + 0.18, 0.55);
    this.fluidFilter.frequency.setTargetAtTime(targetFrequency, now, 0.055);
    this.fluidFilter.frequency.setTargetAtTime(220 + settings.timbre * 520, now + 0.28, 0.65);
    this.fluidPan.pan.setTargetAtTime(pan, now, 0.08);
    this.fluidPan.pan.setTargetAtTime(0, now + 0.28, 0.9);
  }

  private setFluidLevel(value: number, timeConstant: number): void {
    if (!this.context || !this.fluidGain) return;
    this.fluidGain.gain.setTargetAtTime(value, this.context.currentTime, timeConstant);
  }
}
