import { clamp } from "../utils/format";
import type { FlowSignal, ScannerSettings, TradeEvent } from "../types";

export class AudioEngine {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private delay: DelayNode | null = null;
  private feedback: GainNode | null = null;
  private enabled = false;

  async toggle(settings: ScannerSettings): Promise<boolean> {
    this.ensureContext(settings);
    if (!this.context) return false;
    if (this.context.state === "suspended") await this.context.resume();
    this.enabled = !this.enabled;
    return this.enabled;
  }

  setSettings(settings: ScannerSettings): void {
    if (this.master) this.master.gain.value = settings.volume;
    if (this.feedback) this.feedback.gain.value = settings.space * 0.42;
  }

  playTrade(trade: TradeEvent, settings: ScannerSettings): void {
    if (!this.enabled || !this.context || !this.master) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    const pan = this.context.createStereoPanner();
    const sizeTone = clamp(Math.log10(trade.size + 1), 3.5, 7);
    const base = trade.side === "buy" ? 260 : 120;
    const timbreLift = settings.timbre * 190;
    const frequency = base + sizeTone * 28 + timbreLift;

    oscillator.type = settings.timbre > 0.6 ? "sawtooth" : trade.side === "buy" ? "triangle" : "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.72, now + 0.12);
    pan.pan.value = trade.side === "buy" ? -0.45 : 0.45;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(clamp(trade.size / 1_200_000, 0.012, 0.18), now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.15);

    oscillator.connect(gain).connect(pan).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + 0.18);
  }

  playSignal(signal: FlowSignal, settings: ScannerSettings): void {
    if (!this.enabled || !this.context || !this.master) return;
    const now = this.context.currentTime;
    const isCascade = signal.type === "cascadeRisk";
    const isAbsorption = signal.type === "absorptionAsk" || signal.type === "absorptionBid";
    const oscillator = this.context.createOscillator();
    const filter = this.context.createBiquadFilter();
    const gain = this.context.createGain();
    const pan = this.context.createStereoPanner();
    const duration = isCascade ? 0.58 : isAbsorption ? 0.38 : 0.26;
    const base = signal.side === "buy" ? 360 : signal.side === "sell" ? 92 : 180;

    oscillator.type = isCascade ? "sawtooth" : isAbsorption ? "square" : "triangle";
    oscillator.frequency.setValueAtTime(base + signal.intensity * 90, now);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(44, base * 0.48), now + duration);
    filter.type = isAbsorption ? "lowpass" : "bandpass";
    filter.frequency.value = isAbsorption ? 420 + settings.timbre * 900 : 900 + signal.intensity * 340;
    filter.Q.value = isCascade ? 3.4 : 1.1 + settings.timbre * 4;
    pan.pan.value = signal.side === "buy" ? -0.65 : signal.side === "sell" ? 0.65 : 0;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(clamp(signal.intensity / 9, 0.025, 0.35) * settings.cascadeIntensity, now + 0.018);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);

    oscillator.connect(filter).connect(gain).connect(pan).connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.04);
  }

  private ensureContext(settings: ScannerSettings): void {
    if (this.context) return;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    this.context = new AudioContextClass();
    this.master = this.context.createGain();
    this.delay = this.context.createDelay(0.7);
    this.feedback = this.context.createGain();

    this.master.gain.value = settings.volume;
    this.delay.delayTime.value = 0.18;
    this.feedback.gain.value = settings.space * 0.42;

    this.master.connect(this.context.destination);
    this.master.connect(this.delay);
    this.delay.connect(this.feedback);
    this.feedback.connect(this.delay);
    this.delay.connect(this.context.destination);
  }
}
