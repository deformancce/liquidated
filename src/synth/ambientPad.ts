import * as Tone from "tone";

export interface AmbientParams {
  level: number;
  pitch: number; // semitones offset for the whole drone
  tone: number; // lowpass cutoff
  movement: number; // filter LFO rate (Hz)
  width: number; // chorus / detune amount
  shimmer: number; // octave-up sine layer
  space: number; // reverb mix
}

export const DEFAULT_AMBIENT: AmbientParams = {
  level: 0.4,
  pitch: 0,
  tone: 1800,
  movement: 0.08,
  width: 0.4,
  shimmer: 0.2,
  space: 0.6,
};

const BASE_FREQ = 110; // A2
const INTERVALS = [0, 7, 12, 19]; // quintal, key-neutral drone voicing

/**
 * Slow evolving oscillator pad meant to sit underneath the water synth.
 * Oscillators run continuously once started; transport is a gated master gain,
 * so toggling is click-free.
 */
export class AmbientPad {
  private master: Tone.Gain;
  private meter: Tone.Meter;
  private reverb: Tone.Reverb;
  private chorus: Tone.Chorus;
  private filter: Tone.Filter;
  private lfo: Tone.LFO;
  private voices: Tone.Oscillator[] = [];
  private shimmerOsc: Tone.Oscillator;
  private shimmerGain: Tone.Gain;
  private params: AmbientParams = { ...DEFAULT_AMBIENT };
  private started = false;
  private playing = false;

  constructor() {
    this.master = new Tone.Gain(0).toDestination();
    this.meter = new Tone.Meter({ smoothing: 0.9 });
    this.master.connect(this.meter);

    this.reverb = new Tone.Reverb({ decay: 8, preDelay: 0.05, wet: DEFAULT_AMBIENT.space }).connect(this.master);
    this.chorus = new Tone.Chorus({ frequency: 0.3, delayTime: 4, depth: DEFAULT_AMBIENT.width, feedback: 0.1, wet: 0.6 })
      .connect(this.reverb)
      .start();
    this.filter = new Tone.Filter({ type: "lowpass", frequency: DEFAULT_AMBIENT.tone, rolloff: -24, Q: 0.6 }).connect(
      this.chorus
    );

    this.lfo = new Tone.LFO({ frequency: DEFAULT_AMBIENT.movement, min: 0, max: 0 });
    this.lfo.connect(this.filter.frequency).start();

    INTERVALS.forEach((interval, index) => {
      const osc = new Tone.Oscillator({
        frequency: this.voiceFreq(DEFAULT_AMBIENT.pitch, interval),
        type: index === 0 ? "sawtooth" : "triangle",
        volume: -14,
      }).connect(this.filter);
      this.voices.push(osc);
    });

    this.shimmerGain = new Tone.Gain(DEFAULT_AMBIENT.shimmer * 0.4).connect(this.filter);
    this.shimmerOsc = new Tone.Oscillator({
      frequency: this.voiceFreq(DEFAULT_AMBIENT.pitch, 24),
      type: "sine",
      volume: -8,
    }).connect(this.shimmerGain);

    this.applyParams(DEFAULT_AMBIENT);
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  getLevel(): number {
    const value = this.meter.getValue();
    const db = Array.isArray(value) ? Math.max(...value) : value;
    if (!Number.isFinite(db)) return 0;
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  async start(): Promise<void> {
    if (this.playing) return;
    await Tone.start();
    if (!this.started) {
      this.voices.forEach((osc) => osc.start());
      this.shimmerOsc.start();
      this.started = true;
    }
    this.playing = true;
    this.master.gain.rampTo(this.params.level, 1.2);
  }

  stop(): void {
    this.playing = false;
    this.master.gain.rampTo(0, 1.5);
  }

  async toggle(): Promise<boolean> {
    if (this.playing) this.stop();
    else await this.start();
    return this.playing;
  }

  applyParams(next: AmbientParams): void {
    this.params = next;
    if (this.playing) this.master.gain.rampTo(next.level, 0.1);
    this.voices.forEach((osc, index) => osc.frequency.rampTo(this.voiceFreq(next.pitch, INTERVALS[index]), 0.15));
    this.shimmerOsc.frequency.rampTo(this.voiceFreq(next.pitch, 24), 0.15);
    this.shimmerGain.gain.rampTo(next.shimmer * 0.4, 0.1);
    const cutoff = next.tone;
    const depth = Math.min(cutoff * 0.6, 400 + next.movement * 1200);
    this.lfo.min = Math.max(80, cutoff - depth);
    this.lfo.max = cutoff + depth;
    this.lfo.frequency.rampTo(next.movement, 0.1);
    this.chorus.depth = next.width;
    this.chorus.frequency.rampTo(0.1 + next.width * 0.8, 0.1);
    this.reverb.wet.rampTo(next.space, 0.1);
  }

  dispose(): void {
    this.lfo.dispose();
    this.voices.forEach((osc) => osc.dispose());
    this.shimmerOsc.dispose();
    this.shimmerGain.dispose();
    this.filter.dispose();
    this.chorus.dispose();
    this.reverb.dispose();
    this.meter.dispose();
    this.master.dispose();
  }

  private voiceFreq(pitch: number, interval: number): number {
    return BASE_FREQ * Math.pow(2, (pitch + interval) / 12);
  }
}
