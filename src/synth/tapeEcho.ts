import * as Tone from "tone";

/**
 * Strymon El Capistan-style tape echo. Tape character comes from: wow (slow
 * pitch drift) + flutter (fast warble) on the delay time, gentle tape
 * saturation in the feedback path, a high-cut that darkens each repeat
 * ("Hi Damp"), and a low-cut that stops bass build-up at high feedback.
 * (The HD Hall reverb was dropped — Big Sky downstream covers the lush space,
 * so El Capistan is now a pure echo.) Ranges follow the Zoom convention: time
 * in ms, everything else 0..100.
 */
export interface ElCapParams {
  time: number; // ms
  feedback: number; // 0..100
  echoMix: number; // 0..100
  echoDamp: number; // 0..100 (hi damp on repeats)
  echoLevel: number; // 0..100
}

export const DEFAULT_ELCAP: ElCapParams = {
  time: 260,
  feedback: 24,
  echoMix: 22,
  echoDamp: 5,
  echoLevel: 100,
};

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

export class ElCapistan {
  readonly input: Tone.Gain;
  readonly output: Tone.Gain;

  private echoDry: Tone.Gain;
  private echoWet: Tone.Gain;
  private boost: Tone.Gain; // reactive swell multiplier (1 = neutral)
  private delay: Tone.Delay;
  private feedback: Tone.Gain;
  private damp: Tone.Filter; // hi-cut (darkens repeats)
  private lowCut: Tone.Filter; // hi-pass (tames bass build-up)
  private sat: Tone.Distortion; // tape saturation
  private wow: Tone.LFO;
  private flutter: Tone.LFO;
  private params: ElCapParams = { ...DEFAULT_ELCAP };

  constructor() {
    this.input = new Tone.Gain(1);
    this.output = new Tone.Gain(1);

    this.delay = new Tone.Delay({ delayTime: DEFAULT_ELCAP.time / 1000, maxDelay: 2 });
    this.damp = new Tone.Filter({ type: "lowpass", frequency: 17000, rolloff: -12 });
    this.lowCut = new Tone.Filter({ type: "highpass", frequency: 120, rolloff: -12 });
    this.sat = new Tone.Distortion({ distortion: 0.06, oversample: "2x", wet: 1 });
    this.feedback = new Tone.Gain(DEFAULT_ELCAP.feedback / 100);

    // feedback loop: delay -> damp -> lowCut -> saturate -> feedback gain -> delay
    this.delay.connect(this.damp);
    this.damp.connect(this.lowCut);
    this.lowCut.connect(this.sat);
    this.sat.connect(this.feedback);
    this.feedback.connect(this.delay);

    // wow & flutter modulate the delay time around its base value
    this.wow = new Tone.LFO({ frequency: 0.6, min: -0.0028, max: 0.0028 }).start();
    this.flutter = new Tone.LFO({ frequency: 6.5, min: -0.0005, max: 0.0005 }).start();
    this.wow.connect(this.delay.delayTime);
    this.flutter.connect(this.delay.delayTime);

    // dry + echo blend straight to the output (echo wet runs through a boost stage)
    this.echoDry = new Tone.Gain(1).connect(this.output);
    this.boost = new Tone.Gain(1).connect(this.output);
    this.echoWet = new Tone.Gain((DEFAULT_ELCAP.echoMix / 100) * (DEFAULT_ELCAP.echoLevel / 100)).connect(this.boost);
    this.input.connect(this.delay);
    this.input.connect(this.echoDry);
    this.delay.connect(this.echoWet);

    this.applyParams(DEFAULT_ELCAP);
  }

  applyParams(next: ElCapParams): void {
    this.params = next;
    this.delay.delayTime.rampTo(next.time / 1000, 0.08);
    this.feedback.gain.rampTo(clamp01(next.feedback / 100), 0.05);
    this.echoWet.gain.rampTo(clamp01(next.echoMix / 100) * clamp01(next.echoLevel / 100), 0.05);
    // hi damp: 0 = bright (~18k), 100 = dark (~1.8k)
    this.damp.frequency.rampTo(18000 * (1 - clamp01(next.echoDamp / 100) * 0.9), 0.05);
  }

  /**
   * Briefly swell the echo wet by `amount` (0..~3), then settle back. Used to
   * push the repeats harder when a large order arrives.
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
    this.wow.dispose();
    this.flutter.dispose();
    this.delay.dispose();
    this.damp.dispose();
    this.lowCut.dispose();
    this.sat.dispose();
    this.feedback.dispose();
    this.echoDry.dispose();
    this.echoWet.dispose();
    this.boost.dispose();
    this.input.dispose();
    this.output.dispose();
  }
}
