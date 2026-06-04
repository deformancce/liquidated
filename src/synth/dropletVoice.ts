import * as Tone from "tone";
import { bipolar, DropletPool, maybeQuantize, scaleNoteAbove } from "./water";

export interface DropletParams {
  level: number; // master gain 0..1
  density: number; // average droplets per second
  pitch: number; // centre frequency (Hz)
  spread: number; // random pitch spread in octaves (0..1 -> 0..2 oct)
  sweep: number; // pitch-rise amount 0..1
  decay: number; // body length (s)
  transient: number; // impact-noise amount 0..1
  tone: number; // voice lowpass cutoff (Hz)
  space: number; // reverb mix 0..1
  echo: number; // 0..1 send into the shared El Capistan echo
  sync: number; // 0/1 — fire on the tempo grid instead of freely
  rate: number; // index into RATES (note division when synced)
  arp: number; // 0/1 — walk the scale upward each synced step
}

export interface DropletHit {
  freq?: number;
  spread?: number;
  sweep?: number;
  decay?: number;
  amp?: number;
  transient?: number;
}

export const DEFAULT_DROPLET: DropletParams = {
  level: 0.7,
  density: 6,
  pitch: 900,
  spread: 0.6,
  sweep: 0.55,
  decay: 0.07,
  transient: 0.3,
  tone: 9000,
  space: 0.35,
  echo: 0.35,
  sync: 0,
  rate: 3,
  arp: 0,
};

const GRID = 0.02; // free-mode scheduler resolution (s) -> up to 50 triggers/s
/** Note divisions selectable when synced; index = DropletParams.rate. */
export const RATES = ["1n", "2n", "4n", "8n", "8t", "16n"];
const ARP_RANGE = 8; // scale degrees the arpeggio climbs before wrapping

/**
 * Discrete water droplets. A fine Transport grid fires randomized plinks at a
 * controllable average rate; each droplet varies in pitch, length and loudness
 * to dodge the "machine-gun" artefact of identical impulses.
 */
export class DropletVoice {
  private master: Tone.Gain;
  private filter: Tone.Filter;
  private dry: Tone.Gain;
  private reverbSend: Tone.Gain;
  private echoSend: Tone.Gain;
  private meter: Tone.Meter;
  private bus: Tone.Gain;
  private pool: DropletPool;
  private params: DropletParams = { ...DEFAULT_DROPLET };
  private scheduleId = -1;
  private playing = false;
  private arpStep = 0;

  constructor(output?: Tone.ToneAudioNode, echoBus?: Tone.ToneAudioNode, spaceBus?: Tone.ToneAudioNode) {
    this.master = new Tone.Gain(0);
    this.master.connect(output ?? Tone.getDestination());
    this.meter = new Tone.Meter({ smoothing: 0.85 });
    this.master.connect(this.meter);

    this.dry = new Tone.Gain(1).connect(this.master);

    // Post-fader sends (parallel to dry): shared Space reverb + El Capistan echo.
    this.reverbSend = new Tone.Gain(DEFAULT_DROPLET.space);
    if (spaceBus) {
      this.master.connect(this.reverbSend);
      this.reverbSend.connect(spaceBus);
    }
    this.echoSend = new Tone.Gain(DEFAULT_DROPLET.echo);
    if (echoBus) {
      this.master.connect(this.echoSend);
      this.echoSend.connect(echoBus);
    }

    this.filter = new Tone.Filter({ type: "lowpass", frequency: DEFAULT_DROPLET.tone, rolloff: -12 });
    this.filter.connect(this.dry);

    // Droplets connect into this bus; the bus feeds the tone filter.
    this.bus = new Tone.Gain(1).connect(this.filter);
    this.pool = new DropletPool(this.bus, 16, 8);
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
    const context = Tone.getContext();
    if (context.state !== "running") await context.resume();
    const transport = Tone.getTransport();
    if (transport.state !== "started") transport.start();
    this.pool.start();
    this.playing = true;
    this.install();
    this.master.gain.rampTo(this.params.level, 0.1);
  }

  /** Install the right scheduler for the current sync mode (free grid vs. note division). */
  private install(): void {
    const transport = Tone.getTransport();
    if (this.scheduleId >= 0) {
      transport.clear(this.scheduleId);
      this.scheduleId = -1;
    }
    if (this.params.sync >= 0.5) {
      const div = RATES[Math.round(this.params.rate)] ?? "8n";
      this.scheduleId = transport.scheduleRepeat((time) => this.syncTick(time), div);
    } else {
      this.scheduleId = transport.scheduleRepeat((time) => this.tick(time), GRID);
    }
  }

  stop(): void {
    this.playing = false;
    this.master.gain.rampTo(0, 0.3);
  }

  async toggle(): Promise<boolean> {
    if (this.playing) this.stop();
    else await this.start();
    return this.playing;
  }

  applyParams(next: DropletParams): void {
    const prev = this.params;
    this.params = next;
    if (this.playing) this.master.gain.rampTo(next.level, 0.1);
    this.filter.frequency.rampTo(next.tone, 0.05);
    this.reverbSend.gain.rampTo(next.space, 0.05);
    this.echoSend.gain.rampTo(next.echo, 0.05);
    const modeChanged =
      Math.round(prev.sync) !== Math.round(next.sync) || Math.round(prev.rate) !== Math.round(next.rate);
    if (this.playing && modeChanged) this.install();
  }

  triggerDrop(time = Tone.now() + 0.05, hit: DropletHit = {}): void {
    const p = this.params;
    this.pool.start();
    if (!this.playing) {
      const now = Tone.now();
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(p.level, now, 0.008);
    }

    const spread = hit.spread ?? p.spread;
    const freq = maybeQuantize((hit.freq ?? p.pitch) * Math.pow(2, bipolar() * spread));
    const sweep = hit.sweep ?? 1 + p.sweep * 2 * (0.6 + Math.random() * 0.8);
    const damping = Math.max(0.25, Math.min(2.2, 1500 / freq));
    const decay = hit.decay ?? p.decay * damping * (0.6 + Math.random() * 0.7);
    const amp = hit.amp ?? (0.4 + Math.random() * 0.6) * (freq < 900 ? 1.15 : 0.92);
    this.pool.trigger(time, {
      freq,
      sweep,
      decay,
      amp,
      transient: hit.transient ?? p.transient,
    });
  }

  dispose(): void {
    if (this.scheduleId >= 0) Tone.getTransport().clear(this.scheduleId);
    this.pool.dispose();
    this.bus.dispose();
    this.filter.dispose();
    this.dry.dispose();
    this.reverbSend.dispose();
    this.echoSend.dispose();
    this.meter.dispose();
    this.master.dispose();
  }

  /** Free mode: probabilistic firing on a fine grid. */
  private tick(time: number): void {
    if (!this.playing) return;
    const expected = this.params.density * GRID;
    let count = Math.floor(expected);
    if (Math.random() < expected - count) count += 1;
    for (let i = 0; i < count; i += 1) {
      this.emit(time + Math.random() * GRID, false);
    }
  }

  /** Synced mode: one chance per note division, probability scaled by density. */
  private syncTick(time: number): void {
    if (!this.playing) return;
    const div = RATES[Math.round(this.params.rate)] ?? "8n";
    const stepDur = Tone.Time(div).toSeconds();
    const prob = Math.min(1, this.params.density * stepDur);
    if (Math.random() > prob) return;
    this.emit(time, true);
  }

  private emit(time: number, stepped: boolean): void {
    const p = this.params;
    let freq: number;
    if (stepped && p.arp >= 0.5) {
      // Climb the scale one degree per step, wrapping after ARP_RANGE.
      freq = scaleNoteAbove(p.pitch, this.arpStep);
      this.arpStep = (this.arpStep + 1) % ARP_RANGE;
    } else {
      freq = maybeQuantize(p.pitch * Math.pow(2, bipolar() * p.spread));
    }
    const sweep = 1 + p.sweep * 2 * (0.6 + Math.random() * 0.8);
    // Minnaert damping: higher bubbles ring shorter, lower bubbles longer.
    const damping = Math.max(0.25, Math.min(2.2, 1500 / freq));
    const decay = p.decay * damping * (0.6 + Math.random() * 0.7);
    // Bigger (lower) drops read slightly louder.
    const amp = (0.4 + Math.random() * 0.6) * (freq < 900 ? 1.15 : 0.92);
    this.pool.trigger(time, { freq, sweep, decay, amp, transient: p.transient });
  }
}
