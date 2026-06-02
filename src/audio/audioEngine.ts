import * as Tone from "tone";
import { clamp } from "../utils/format";
import type { FlowSignal, ScannerSettings, TradeEvent } from "../types";

interface WaterPingInput {
  pan: number;
  sizeTone: number;
  intensity: number;
  hollow: number;
  duration: number;
  longReverb: number;
  settings: ScannerSettings;
  cascade?: boolean;
}

const WATER_PRESET = {
  dropPitch: 520,
  pitchSpread: 155,
  pitchSweep: 1.86,
  resonance: 26,
  secondResonance: 18,
  hollow: 0.68,
  clickDecay: 0.045,
  pingDecay: 0.38,
  bodyAmount: 0.035,
  dryGain: 0.18,
  shortDelayTime: 0.17,
  shortDelayFeedback: 0.34,
  longReverbDecay: 5.2,
  longReverbPreDelay: 0.08,
  longSend: 0.36,
  droneBase: 0.028,
};

export class AudioEngine {
  private enabled = false;
  private ready = false;
  private master: Tone.Gain | null = null;
  private shortDelay: Tone.PingPongDelay | null = null;
  private longReverb: Tone.Reverb | null = null;
  private longSend: Tone.Gain | null = null;
  private droneGain: Tone.Gain | null = null;
  private droneFilter: Tone.Filter | null = null;
  private dronePan: Tone.Panner | null = null;
  private droneOscillators: Tone.Oscillator[] = [];

  async toggle(settings: ScannerSettings): Promise<boolean> {
    await this.ensureTone(settings);
    this.enabled = !this.enabled;
    this.setDroneLevel(this.enabled ? WATER_PRESET.droneBase : 0.0001, 0.35);
    return this.enabled;
  }

  setSettings(settings: ScannerSettings): void {
    if (!this.ready) return;
    this.master?.gain.rampTo(settings.volume, 0.08);
    this.shortDelay?.feedback.rampTo(WATER_PRESET.shortDelayFeedback + settings.space * 0.22, 0.12);
    this.shortDelay?.wet.rampTo(0.14 + settings.space * 0.22, 0.12);
    this.longReverb?.wet.rampTo(0.18 + settings.space * 0.36, 0.2);
    this.droneFilter?.frequency.rampTo(220 + settings.timbre * 640, 0.2);
    this.droneFilter?.Q.rampTo(0.9 + settings.space * 2.4, 0.2);
  }

  playTrade(trade: TradeEvent, settings: ScannerSettings): void {
    if (!this.enabled || !this.ready) return;
    const sizeTone = clamp(Math.log10(trade.size + 1), 3.5, 7);
    const intensity = clamp(trade.size / 1_200_000, 0.012, 0.18);
    this.exciteFluid(trade.side === "buy" ? -0.35 : 0.35, sizeTone, intensity, settings);
    this.playWaterPing({
      pan: trade.side === "buy" ? -0.32 : 0.32,
      sizeTone,
      intensity: intensity * 1.9,
      hollow: 0.45 + settings.timbre * 0.45,
      duration: 0.34,
      longReverb: clamp((trade.size - settings.minPrintSize * 4) / (settings.minPrintSize * 18), 0, 1),
      settings,
    });
  }

  playSignal(signal: FlowSignal, settings: ScannerSettings): void {
    if (!this.enabled || !this.ready) return;
    const isCascade = signal.type === "cascadeRisk";
    const isAbsorption = signal.type === "absorptionAsk" || signal.type === "absorptionBid";

    this.exciteFluid(signal.side === "buy" ? -0.48 : signal.side === "sell" ? 0.48 : 0, signal.intensity + 4, signal.intensity / 7, settings);
    this.playWaterPing({
      pan: signal.side === "buy" ? -0.46 : signal.side === "sell" ? 0.46 : 0,
      sizeTone: signal.intensity + 4.2,
      intensity: clamp(signal.intensity / 4.5, 0.18, isCascade ? 1.4 : 0.85),
      hollow: isAbsorption ? 0.25 : 0.7,
      duration: isCascade ? 0.82 : isAbsorption ? 0.52 : 0.42,
      longReverb: isCascade ? 1 : clamp(signal.intensity / 3.8, 0, 0.85),
      settings,
      cascade: isCascade,
    });

    if (isCascade) {
      this.playCascadeWash(settings, signal.side === "buy" ? -0.2 : signal.side === "sell" ? 0.2 : 0, signal.intensity);
    }
  }

  private async ensureTone(settings: ScannerSettings): Promise<void> {
    if (this.ready) return;
    await Tone.start();

    this.master = new Tone.Gain(settings.volume).toDestination();
    this.shortDelay = new Tone.PingPongDelay({
      delayTime: WATER_PRESET.shortDelayTime,
      feedback: WATER_PRESET.shortDelayFeedback + settings.space * 0.22,
      wet: 0.14 + settings.space * 0.22,
    }).connect(this.master);
    this.longReverb = new Tone.Reverb({
      decay: WATER_PRESET.longReverbDecay,
      preDelay: WATER_PRESET.longReverbPreDelay,
      wet: 0.18 + settings.space * 0.36,
    }).connect(this.master);
    this.longSend = new Tone.Gain(0).connect(this.longReverb);
    this.droneGain = new Tone.Gain(0.0001);
    this.droneFilter = new Tone.Filter({
      type: "lowpass",
      frequency: 220 + settings.timbre * 640,
      Q: 0.9 + settings.space * 2.4,
      rolloff: -24,
    });
    this.dronePan = new Tone.Panner(0).connect(this.master);

    this.droneGain.chain(this.droneFilter, this.dronePan);
    this.createDroneOscillator(61.7, "sine");
    this.createDroneOscillator(92.5, "triangle");
    this.createDroneOscillator(123.4, "sine");
    this.ready = true;
  }

  private createDroneOscillator(frequency: number, type: "sine" | "triangle"): void {
    if (!this.droneGain) return;
    const oscillator = new Tone.Oscillator({ frequency, type, volume: type === "triangle" ? -18 : -22 }).connect(this.droneGain);
    oscillator.start();
    this.droneOscillators.push(oscillator);
  }

  private playWaterPing(input: WaterPingInput): void {
    if (!this.master || !this.shortDelay || !this.longSend) return;
    const now = Tone.now();
    const random = Math.random();
    const amount = clamp(input.intensity, 0.04, input.cascade ? 1.4 : 0.8);
    const base = WATER_PRESET.dropPitch + input.sizeTone * WATER_PRESET.pitchSpread + input.settings.timbre * 420 + random * 130;
    const top = base * (WATER_PRESET.pitchSweep + input.hollow * 0.42);
    const duration = input.duration + random * 0.06;
    const panValue = input.pan + (random - 0.5) * 0.16;

    const pan = new Tone.Panner(panValue);
    const pingA = new Tone.Filter({
      type: "bandpass",
      frequency: base * 0.78,
      Q: WATER_PRESET.resonance + input.hollow * 16,
      rolloff: -24,
    });
    const pingB = new Tone.Filter({
      type: "bandpass",
      frequency: base * 1.42,
      Q: WATER_PRESET.secondResonance + input.hollow * 12,
      rolloff: -12,
    });
    const highpass = new Tone.Filter({ type: "highpass", frequency: 160, rolloff: -12 });
    const dropGain = new Tone.Gain(0);
    const longGain = new Tone.Gain(clamp(input.longReverb, 0, 1) * WATER_PRESET.longSend * (0.65 + input.settings.space));
    const body = new Tone.Oscillator({ type: "sine", frequency: base * 0.46 });
    const bodyGain = new Tone.Gain(0);
    const noise = new Tone.Noise("white");

    noise.chain(highpass, pingA, pingB, dropGain, pan);
    body.connect(bodyGain);
    bodyGain.connect(pan);
    pan.connect(this.master);
    pan.connect(this.shortDelay);
    dropGain.connect(longGain);
    bodyGain.connect(longGain);
    longGain.connect(this.longSend);

    pingA.frequency.exponentialRampToValueAtTime(top, now + 0.09 + input.hollow * 0.05);
    pingA.frequency.exponentialRampToValueAtTime(base * 1.18, now + duration);
    pingB.frequency.exponentialRampToValueAtTime(top * 1.26, now + 0.12);
    pingB.frequency.exponentialRampToValueAtTime(base * 1.08, now + duration);
    body.frequency.exponentialRampToValueAtTime(base * 0.84, now + 0.16);

    dropGain.gain.setValueAtTime(0.0001, now);
    dropGain.gain.exponentialRampToValueAtTime(amount * WATER_PRESET.dryGain * input.settings.cascadeIntensity, now + 0.012);
    dropGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    bodyGain.gain.setValueAtTime(0.0001, now);
    bodyGain.gain.exponentialRampToValueAtTime(amount * WATER_PRESET.bodyAmount, now + 0.018);
    bodyGain.gain.exponentialRampToValueAtTime(0.0001, now + duration * 0.86);
    longGain.gain.exponentialRampToValueAtTime(0.0001, now + duration + 0.22);

    noise.start(now);
    noise.stop(now + WATER_PRESET.clickDecay);
    body.start(now);
    body.stop(now + duration);

    window.setTimeout(() => {
      noise.dispose();
      body.dispose();
      bodyGain.dispose();
      dropGain.dispose();
      highpass.dispose();
      pingA.dispose();
      pingB.dispose();
      pan.dispose();
      longGain.dispose();
    }, (duration + 1.2) * 1000);
  }

  private playCascadeWash(settings: ScannerSettings, panValue: number, intensity: number): void {
    if (!this.master || !this.longSend) return;
    const now = Tone.now();
    const noise = new Tone.Noise("brown");
    const filter = new Tone.Filter({
      type: "bandpass",
      frequency: 280 + intensity * 80,
      Q: 2.8,
      rolloff: -24,
    });
    const gain = new Tone.Gain(0);
    const pan = new Tone.Panner(panValue);

    noise.chain(filter, gain, pan);
    pan.connect(this.master);
    pan.connect(this.longSend);
    filter.frequency.exponentialRampToValueAtTime(1200 + intensity * 160, now + 0.26);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(clamp(intensity / 18, 0.025, 0.18) * settings.cascadeIntensity, now + 0.08);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.65);

    noise.start(now);
    noise.stop(now + 0.7);
    window.setTimeout(() => {
      noise.dispose();
      filter.dispose();
      gain.dispose();
      pan.dispose();
    }, 1400);
  }

  private exciteFluid(pan: number, tone: number, intensity: number, settings: ScannerSettings): void {
    if (!this.droneGain || !this.droneFilter || !this.dronePan) return;
    const now = Tone.now();
    const lift = clamp(tone / 7, 0.35, 1.2);
    const targetGain = clamp(WATER_PRESET.droneBase + intensity * 0.34, WATER_PRESET.droneBase, 0.18) * settings.cascadeIntensity;
    const targetFrequency = 180 + lift * 520 + settings.timbre * 740;

    this.droneGain.gain.cancelScheduledValues(now);
    this.droneGain.gain.setTargetAtTime(targetGain, now, 0.045);
    this.droneGain.gain.setTargetAtTime(this.enabled ? WATER_PRESET.droneBase : 0.0001, now + 0.18, 0.55);
    this.droneFilter.frequency.setTargetAtTime(targetFrequency, now, 0.055);
    this.droneFilter.frequency.setTargetAtTime(220 + settings.timbre * 520, now + 0.28, 0.65);
    this.dronePan.pan.setTargetAtTime(pan, now, 0.08);
    this.dronePan.pan.setTargetAtTime(0, now + 0.28, 0.9);
  }

  private setDroneLevel(value: number, timeConstant: number): void {
    if (!this.droneGain) return;
    this.droneGain.gain.setTargetAtTime(value, Tone.now(), timeConstant);
  }
}
