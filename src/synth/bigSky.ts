import * as Tone from "tone";

/**
 * Strymon Big Sky-style lush reverb. A pre-delay sets the gap before the tail,
 * a long algorithmic decay builds the "sky", a gentle chorus modulation keeps
 * the tail from sounding static (the shimmery, moving quality Big Sky is known
 * for), and a "Color" high-cut darkens the wash. `pulse()` briefly swells the
 * wet level so a large order can bloom the reverb. Ranges follow the Zoom
 * convention (0..100).
 */
export interface BigSkyParams {
  size: number; // 0..100 -> reverb decay (s)
  predelay: number; // 0..100 -> 0..150 ms gap before the tail
  mod: number; // 0..100 chorus modulation on the tail
  color: number; // 0..100 reverb tone (high-cut)
  mix: number; // 0..100 reverb wet
}

export const DEFAULT_BIGSKY: BigSkyParams = {
  size: 55,
  predelay: 20,
  mod: 35,
  color: 60,
  mix: 35,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
// Big Sky goes large: 0.5 s .. ~16 s
const decaySeconds = (d: number) => 0.5 + Math.pow(clamp01(d / 100), 1.4) * 15.5;

export class BigSky {
  readonly input: Tone.Gain;
  readonly output: Tone.Gain;

  private dry: Tone.Gain;
  private predelay: Tone.Delay;
  private reverb: Tone.Reverb;
  private color: Tone.Filter;
  private mod: Tone.Chorus;
  private wet: Tone.Gain;
  private boost: Tone.Gain; // reactive swell multiplier (1 = neutral)
  private params: BigSkyParams = { ...DEFAULT_BIGSKY };
  private lastDecay = -1;

  constructor() {
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(1);

    // dry pass-through
    this.dry = new Tone.Gain(1).connect(this.output);
    this.input.connect(this.dry);

    // wet path: predelay -> reverb -> color high-cut -> chorus mod -> wet -> boost -> out
    this.predelay = new Tone.Delay({ delayTime: DEFAULT_BIGSKY.predelay / 100 * 0.15, maxDelay: 0.2 });
    this.reverb = new Tone.Reverb({ decay: decaySeconds(DEFAULT_BIGSKY.size), preDelay: 0.01, wet: 1 });
    this.color = new Tone.Filter({ type: "lowpass", frequency: 9000, rolloff: -12 });
    this.mod = new Tone.Chorus({ frequency: 0.3, delayTime: 6, depth: 0.4, spread: 180, wet: 1 }).start();
    this.wet = new Tone.Gain(DEFAULT_BIGSKY.mix / 100);
    this.boost = new Tone.Gain(1).connect(this.output);

    this.input.connect(this.predelay);
    this.predelay.connect(this.reverb);
    this.reverb.connect(this.color);
    this.color.connect(this.mod);
    this.mod.connect(this.wet);
    this.wet.connect(this.boost);

    this.applyParams(DEFAULT_BIGSKY);
  }

  applyParams(next: BigSkyParams): void {
    this.params = next;
    this.predelay.delayTime.rampTo(clamp01(next.predelay / 100) * 0.15, 0.05);
    this.color.frequency.rampTo(500 + clamp01(next.color / 100) * 15000, 0.05);
    this.mod.depth = clamp01(next.mod / 100) * 0.8;
    this.wet.gain.rampTo(clamp01(next.mix / 100), 0.05);
    if (Math.round(next.size) !== this.lastDecay) {
      this.lastDecay = Math.round(next.size);
      this.reverb.decay = decaySeconds(next.size);
    }
  }

  /**
   * Briefly swell the reverb wet by `amount` (0..~3), then settle back. Used to
   * bloom the tail when a large order arrives.
   */
  pulse(amount: number, release = 3): void {
    const now = Tone.now();
    const peak = 1 + Math.max(0, amount);
    this.boost.gain.cancelScheduledValues(now);
    this.boost.gain.setValueAtTime(this.boost.gain.value, now);
    this.boost.gain.linearRampToValueAtTime(peak, now + 0.08);
    this.boost.gain.setTargetAtTime(1, now + 0.08, release / 3);
  }

  dispose(): void {
    this.dry.dispose();
    this.predelay.dispose();
    this.reverb.dispose();
    this.color.dispose();
    this.mod.dispose();
    this.wet.dispose();
    this.boost.dispose();
    this.input.dispose();
    this.output.dispose();
  }
}
