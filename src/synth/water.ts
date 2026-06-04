import * as Tone from "tone";

/**
 * A water droplet, modelled as a Minnaert air-bubble (cf. AudioKinetic,
 * "Generating Rain with Pure Synthesis"). A falling drop entrains an air bubble
 * that shrinks rapidly; as it shrinks its resonant frequency RISES, so the body
 * is a short sine (~10–60 ms) with an upward pitch chirp and a fast percussive
 * decay. A brief noise transient models the surface impact.
 */
export interface DropletOptions {
  freq: number; // start frequency (Hz)
  sweep: number; // pitch-rise multiplier, f_end = freq * sweep
  decay: number; // body length (s)
  amp: number; // peak gain 0..1
  transient: number; // impact-noise amount 0..1
}

const clampFreq = (f: number) => Math.max(40, Math.min(18000, f));

/**
 * A fixed pool of always-running voices that droplets are scheduled onto, so no
 * audio nodes are allocated or disposed per hit (the previous per-droplet
 * approach churned dozens of nodes a second and caused GC stalls). Each body
 * voice is a persistent sine -> VCA; each transient voice is a persistent
 * bandpass -> VCA fed by one shared noise source. Triggering only schedules
 * parameter automation. Voices are reused round-robin.
 */
export class DropletPool {
  private osc: Tone.Oscillator[] = [];
  private vca: Tone.Gain[] = [];
  private bp: Tone.Filter[] = [];
  private ng: Tone.Gain[] = [];
  private noise: Tone.Noise;
  private oscIdx = 0;
  private noiseIdx = 0;
  private started = false;

  constructor(dest: Tone.ToneAudioNode, oscVoices = 24, noiseVoices = 10) {
    this.noise = new Tone.Noise("white");
    for (let i = 0; i < oscVoices; i += 1) {
      const osc = new Tone.Oscillator({ frequency: 440, type: "sine" });
      const vca = new Tone.Gain(0);
      osc.connect(vca);
      vca.connect(dest);
      this.osc.push(osc);
      this.vca.push(vca);
    }
    for (let i = 0; i < noiseVoices; i += 1) {
      const bp = new Tone.Filter({ type: "bandpass", frequency: 1000, Q: 1.1 });
      const ng = new Tone.Gain(0);
      this.noise.connect(bp);
      bp.connect(ng);
      ng.connect(dest);
      this.bp.push(bp);
      this.ng.push(ng);
    }
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.noise.start();
    this.osc.forEach((o) => o.start());
  }

  trigger(time: number, o: DropletOptions): void {
    if (!this.started) return;
    const attack = Math.min(0.0015, o.decay * 0.15);
    const end = time + o.decay;

    // --- resonant body: rising-pitch sine through a VCA ---
    const i = this.oscIdx;
    this.oscIdx = (this.oscIdx + 1) % this.osc.length;
    const freq = clampFreq(o.freq);
    const fEnd = clampFreq(o.freq * o.sweep);

    const f = this.osc[i].frequency;
    f.cancelScheduledValues(time);
    f.setValueAtTime(freq, time);
    f.exponentialRampToValueAtTime(fEnd, time + o.decay * 0.9);

    const g = this.vca[i].gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(0, time);
    g.linearRampToValueAtTime(o.amp, time + attack);
    g.exponentialRampToValueAtTime(0.0005, end);
    g.linearRampToValueAtTime(0, end + 0.005);

    // --- impact transient: short bandpassed noise burst ---
    if (o.transient > 0.001 && this.ng.length > 0) {
      const j = this.noiseIdx;
      this.noiseIdx = (this.noiseIdx + 1) % this.ng.length;
      const tDur = Math.min(0.025, o.decay * 0.6);
      this.bp[j].frequency.setValueAtTime(clampFreq(o.freq * 1.6), time);
      const ng = this.ng[j].gain;
      ng.cancelScheduledValues(time);
      ng.setValueAtTime(0, time);
      ng.setValueAtTime(o.amp * o.transient * 0.7, time);
      ng.exponentialRampToValueAtTime(0.0005, time + tDur);
      ng.linearRampToValueAtTime(0, time + tDur + 0.005);
    }
  }

  dispose(): void {
    this.osc.forEach((o) => o.dispose());
    this.vca.forEach((g) => g.dispose());
    this.bp.forEach((b) => b.dispose());
    this.ng.forEach((g) => g.dispose());
    this.noise.dispose();
  }
}

/** Random value in [-1, 1]. */
export const bipolar = () => Math.random() * 2 - 1;

// --- pitch quantizer ---------------------------------------------------------
export type ScaleName = "major" | "minor" | "majPent" | "minPent";
export const SCALE_NAMES: ScaleName[] = ["major", "minor", "majPent", "minPent"];

// Semitone intervals from the root for each supported scale.
const SCALE_INTERVALS: Record<ScaleName, number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  majPent: [0, 2, 4, 7, 9],
  minPent: [0, 3, 5, 7, 10],
};

let quantizeOn = false;
let activePcs = [2, 4, 6, 7, 9, 11, 1]; // D major by default
let activeRoot = 2;

/** Configure the global scale used to quantize droplet pitches. */
export function setScale(on: boolean, root: number, scale: ScaleName): void {
  quantizeOn = on;
  activeRoot = ((Math.round(root) % 12) + 12) % 12;
  activePcs = SCALE_INTERVALS[scale].map((i) => (i + activeRoot) % 12);
}

const midiToFreq = (m: number) => 440 * Math.pow(2, (m - 69) / 12);
const freqToMidi = (f: number) => 69 + 12 * Math.log2(f / 440);

function snapMidi(midi: number): number {
  const center = Math.round(midi);
  let best = center;
  let bestDist = Infinity;
  for (let m = center - 7; m <= center + 7; m += 1) {
    const pc = ((m % 12) + 12) % 12;
    if (!activePcs.includes(pc)) continue;
    const dist = Math.abs(m - midi);
    if (dist < bestDist) {
      bestDist = dist;
      best = m;
    }
  }
  return best;
}

/** Snap a frequency to the nearest note of the active scale. */
export const snapToScale = (freq: number) => midiToFreq(snapMidi(freqToMidi(freq)));
export const maybeQuantize = (freq: number) => (quantizeOn ? snapToScale(freq) : freq);

/** Frequency `steps` scale-degrees above the snapped base note (for arpeggios). */
export function scaleNoteAbove(baseFreq: number, steps: number): number {
  const baseMidi = snapMidi(freqToMidi(baseFreq));
  const basePc = ((baseMidi % 12) + 12) % 12;
  const sorted = [...activePcs].sort((a, b) => a - b);
  const n = sorted.length;
  let idx = sorted.indexOf(basePc);
  if (idx < 0) idx = 0;
  const degree = idx + steps;
  const octaves = Math.floor(degree / n);
  const within = ((degree % n) + n) % n;
  const baseOctaveC = baseMidi - basePc; // C of the base note's octave
  return midiToFreq(baseOctaveC + octaves * 12 + sorted[within]);
}
