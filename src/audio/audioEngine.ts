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

    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const pan = this.context.createStereoPanner();
    const filter = this.context.createBiquadFilter();
    const base = trade.side === "buy" ? 190 : 128;
    const timbreLift = settings.timbre * 110;
    const frequency = base + sizeTone * 28 + timbreLift;

    oscillator.type = settings.timbre > 0.6 ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.88, now + 0.32);
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(420 + settings.timbre * 720 + sizeTone * 38, now);
    filter.Q.value = 0.7 + settings.space * 2;
    pan.pan.value = trade.side === "buy" ? -0.28 : 0.28;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(intensity * 0.28, now + 0.035);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

    oscillator.connect(filter).connect(gain).connect(pan).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.62);
  }

  playSignal(signal: FlowSignal, settings: ScannerSettings): void {
    if (!this.enabled || !this.context || !this.master) return;
    const now = this.context.currentTime;
    const isCascade = signal.type === "cascadeRisk";
    const isAbsorption = signal.type === "absorptionAsk" || signal.type === "absorptionBid";
    const oscillator = this.context.createOscillator();
    const oscillator2 = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const pan = this.context.createStereoPanner();
    const duration = isCascade ? 1.15 : isAbsorption ? 0.82 : 0.58;
    const base = signal.side === "buy" ? 230 : signal.side === "sell" ? 96 : 156;

    this.exciteFluid(signal.side === "buy" ? -0.48 : signal.side === "sell" ? 0.48 : 0, signal.intensity + 4, signal.intensity / 7, settings);

    oscillator.type = isCascade ? "sawtooth" : isAbsorption ? "triangle" : "sine";
    oscillator2.type = "sine";
    oscillator.frequency.setValueAtTime(base + signal.intensity * 90, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(44, base * 0.64), now + duration);
    oscillator2.frequency.setValueAtTime((base + signal.intensity * 52) * 1.505, now);
    oscillator2.frequency.exponentialRampToValueAtTime(Math.max(66, base * 0.96), now + duration);
    filter.type = isAbsorption ? "lowpass" : "bandpass";
    filter.frequency.value = isAbsorption ? 360 + settings.timbre * 720 : 620 + signal.intensity * 190;
    filter.Q.value = isCascade ? 2.4 : 0.9 + settings.timbre * 2.4;
    pan.pan.value = signal.side === "buy" ? -0.42 : signal.side === "sell" ? 0.42 : 0;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(clamp(signal.intensity / 12, 0.015, 0.22) * settings.cascadeIntensity, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    oscillator.connect(filter).connect(gain).connect(pan).connect(this.master);
    oscillator2.connect(filter);
    oscillator.start(now);
    oscillator2.start(now);
    oscillator.stop(now + duration + 0.04);
    oscillator2.stop(now + duration + 0.04);
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
