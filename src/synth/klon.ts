import * as Tone from "tone";

/**
 * Klon Centaur-style "transparent" overdrive. The character comes from summing
 * a clean buffered path with a soft-clipped (germanium-ish, mildly asymmetric)
 * path — as Gain rises, more of the clipped signal blends in while the clean
 * stays present, so lows and dynamics survive. An active high-shelf ("Treble")
 * tilts the top end. Ranges follow the Zoom convention (0..100).
 */
export interface KlonParams {
  gain: number; // 0..100 drive + dirty blend
  treble: number; // 0..100 active high-shelf tone
  output: number; // 0..100 level
}

export const DEFAULT_KLON: KlonParams = {
  gain: 30,
  treble: 55,
  output: 50,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class Klon {
  readonly input: Tone.Gain;
  readonly output: Tone.Gain;

  private clean: Tone.Gain;
  private drive: Tone.Gain;
  private shaper: Tone.WaveShaper;
  private dirty: Tone.Gain;
  private sum: Tone.Gain;
  private treble: Tone.Filter;
  private params: KlonParams = { ...DEFAULT_KLON };

  constructor() {
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(1);
    this.sum = new Tone.Gain(1);

    // clean buffered path (the transparent half)
    this.clean = new Tone.Gain(0.7).connect(this.sum);
    this.input.connect(this.clean);

    // dirty path: drive -> soft clip -> blend
    this.drive = new Tone.Gain(1);
    this.shaper = new Tone.WaveShaper((x) => {
      // gently asymmetric soft clip for even-harmonic warmth
      const a = x < 0 ? 0.82 : 1.0;
      return Math.tanh(1.2 * a * x);
    }, 2048);
    this.dirty = new Tone.Gain(0).connect(this.sum);
    this.input.connect(this.drive);
    this.drive.connect(this.shaper);
    this.shaper.connect(this.dirty);

    // active treble shelf, then output level
    this.treble = new Tone.Filter({ type: "highshelf", frequency: 1200, gain: 0 });
    this.sum.connect(this.treble);
    this.treble.connect(this.output);

    this.applyParams(DEFAULT_KLON);
  }

  applyParams(next: KlonParams): void {
    this.params = next;
    const g = clamp01(next.gain / 100);
    // drive into the clipper rises steeply; dirty blends in while clean stays
    this.drive.gain.rampTo(1 + g * g * 24, 0.05);
    this.dirty.gain.rampTo(g * 0.9, 0.05);
    this.clean.gain.rampTo(0.7 - g * 0.2, 0.05);
    // treble: 0..100 -> -12..+12 dB high shelf at 1.2 kHz
    this.treble.gain.rampTo((clamp01(next.treble / 100) * 2 - 1) * 12, 0.05);
    this.output.gain.rampTo(clamp01(next.output / 100) * 2, 0.05);
  }

  dispose(): void {
    this.clean.dispose();
    this.drive.dispose();
    this.shaper.dispose();
    this.dirty.dispose();
    this.sum.dispose();
    this.treble.dispose();
    this.input.dispose();
    this.output.dispose();
  }
}
