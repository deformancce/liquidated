import * as Tone from "tone";

/**
 * Strymon Deco-style tape saturation + doubletracker. The signal is driven into
 * a soft tanh "tape" curve, then a second delayed/wobbled copy is summed back —
 * short lag gives doubling/flanging, longer lag a slapback. The doubled track
 * can be summed in or out of phase. Ranges follow the Zoom convention (0..100).
 */
export interface DecoParams {
  saturation: number; // 0..100 tape drive
  volume: number; // 0..100 output makeup
  lag: number; // 0..100 -> doubler delay (ms)
  wobble: number; // 0..100 pitch wobble on the doubled track
  blend: number; // 0..100 doubled-track level
  phase: number; // 0/1 — sum the doubled track out of phase (flange)
}

export const DEFAULT_DECO: DecoParams = {
  saturation: 35,
  volume: 80,
  lag: 30,
  wobble: 25,
  blend: 40,
  phase: 0,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
const lagMs = (v: number) => 1 + clamp01(v / 100) * 79; // 1..80 ms

export class Deco {
  readonly input: Tone.Gain;
  readonly output: Tone.Gain;

  private drive: Tone.Gain; // pre-shaper gain = saturation amount
  private shaper: Tone.WaveShaper;
  private rolloff: Tone.Filter; // gentle tape high-cut
  private makeup: Tone.Gain;
  private mainTrack: Tone.Gain;
  private doubleDelay: Tone.Delay;
  private doubleTrack: Tone.Gain;
  private wobbleLfo: Tone.LFO;
  private params: DecoParams = { ...DEFAULT_DECO };

  constructor() {
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(DEFAULT_DECO.volume / 100);

    // fixed tanh tape curve; drive is controlled by the pre-gain
    this.drive = new Tone.Gain(1);
    this.shaper = new Tone.WaveShaper((x) => Math.tanh(2.2 * x) / Math.tanh(2.2), 2048);
    this.rolloff = new Tone.Filter({ type: "lowpass", frequency: 8000, rolloff: -12 });
    this.makeup = new Tone.Gain(1);

    this.input.connect(this.drive);
    this.drive.connect(this.shaper);
    this.shaper.connect(this.rolloff);
    this.rolloff.connect(this.makeup);

    // main (direct) track
    this.mainTrack = new Tone.Gain(1).connect(this.output);
    this.makeup.connect(this.mainTrack);

    // doubled track: modulated short delay
    this.doubleDelay = new Tone.Delay({ delayTime: lagMs(DEFAULT_DECO.lag) / 1000, maxDelay: 0.1 });
    this.doubleTrack = new Tone.Gain(DEFAULT_DECO.blend / 100).connect(this.output);
    this.makeup.connect(this.doubleDelay);
    this.doubleDelay.connect(this.doubleTrack);

    this.wobbleLfo = new Tone.LFO({ frequency: 4.2, min: 0, max: 0 }).start();
    this.wobbleLfo.connect(this.doubleDelay.delayTime);

    this.applyParams(DEFAULT_DECO);
  }

  applyParams(next: DecoParams): void {
    this.params = next;
    const sat = clamp01(next.saturation / 100);
    this.drive.gain.rampTo(1 + sat * 10, 0.05);
    // makeup tames the level rise from heavy drive
    this.makeup.gain.rampTo(1 / (1 + sat * 2.5), 0.05);
    this.output.gain.rampTo(clamp01(next.volume / 100), 0.05);

    const baseLag = lagMs(next.lag) / 1000;
    this.doubleDelay.delayTime.rampTo(baseLag, 0.05);
    const depth = (clamp01(next.wobble / 100) * baseLag) * 0.4;
    this.wobbleLfo.min = Math.max(0, baseLag - depth);
    this.wobbleLfo.max = baseLag + depth;

    const sign = next.phase >= 0.5 ? -1 : 1;
    this.doubleTrack.gain.rampTo(sign * clamp01(next.blend / 100), 0.05);
  }

  dispose(): void {
    this.wobbleLfo.dispose();
    this.drive.dispose();
    this.shaper.dispose();
    this.rolloff.dispose();
    this.makeup.dispose();
    this.mainTrack.dispose();
    this.doubleDelay.dispose();
    this.doubleTrack.dispose();
    this.input.dispose();
    this.output.dispose();
  }
}
