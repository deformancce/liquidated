import * as Tone from "tone";
import { setScale, SCALE_NAMES } from "./water";

export interface MasterParams {
  tempo: number; // transport BPM (drives synced droplets)
  root: number; // 0..11 scale root (C..B)
  scale: number; // index into SCALE_NAMES
  quantize: number; // 0/1 — snap droplet pitches to the scale
  master: number; // output gain 0..1
}

export const DEFAULT_MASTER: MasterParams = {
  tempo: 96,
  root: 2, // D
  scale: 0, // major
  quantize: 1,
  master: 0.85,
};

/**
 * Output bus. Each droplet track now owns its own FX rack, so the master only
 * sums everything, holds the output gain/meter, and drives the shared scale &
 * tempo. A single "Space" reverb remains for the Flow bed's Space send.
 */
export class MasterBus {
  readonly input: Tone.Gain;
  private space: Tone.Reverb;
  private spaceBus: Tone.Gain;
  private master: Tone.Gain;
  private meter: Tone.Meter;
  private params: MasterParams = { ...DEFAULT_MASTER };

  constructor() {
    this.master = new Tone.Gain(DEFAULT_MASTER.master).toDestination();
    this.meter = new Tone.Meter({ smoothing: 0.85 });
    this.master.connect(this.meter);

    // dry sum (tracks + flow dry connect here)
    this.input = new Tone.Gain(1).connect(this.master);

    // shared "Space" reverb — used by the Flow bed's Space send
    this.space = new Tone.Reverb({ decay: 4, preDelay: 0.02, wet: 1 }).connect(this.master);
    this.spaceBus = new Tone.Gain(1).connect(this.space);

    this.applyParams(DEFAULT_MASTER);
  }

  /** Shared reverb input; the Flow bed connects its Space send here. */
  get spaceInput(): Tone.ToneAudioNode {
    return this.spaceBus;
  }

  getLevel(): number {
    const value = this.meter.getValue();
    const db = Array.isArray(value) ? Math.max(...value) : value;
    if (!Number.isFinite(db)) return 0;
    return Math.max(0, Math.min(1, (db + 60) / 60));
  }

  applyParams(next: MasterParams): void {
    this.params = next;
    Tone.getTransport().bpm.rampTo(next.tempo, 0.1);
    const scaleName = SCALE_NAMES[Math.round(next.scale)] ?? "major";
    setScale(next.quantize >= 0.5, next.root, scaleName);
    this.master.gain.rampTo(next.master, 0.1);
  }

  dispose(): void {
    this.input.dispose();
    this.space.dispose();
    this.spaceBus.dispose();
    this.meter.dispose();
    this.master.dispose();
  }
}
