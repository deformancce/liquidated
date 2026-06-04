import * as Tone from "tone";
import { bipolar, DropletPool, maybeQuantize } from "./water";

export interface FlowParams {
  level: number; // master gain 0..1
  noise: number; // turbulence noise-bed level 0..1
  lows: number; // low band gain 0..1
  mids: number; // mid band gain 0..1
  highs: number; // high band gain 0..1
  movement: number; // turbulence LFO rate (Hz)
  bubble: number; // dense micro-droplet rate (per second)
  tone: number; // overall lowpass cutoff (Hz)
  space: number; // reverb mix 0..1
  echo: number; // 0..1 send into the shared El Capistan echo
}

export const DEFAULT_FLOW: FlowParams = {
  level: 0.6,
  noise: 0.5,
  lows: 0.4,
  mids: 0.6,
  highs: 0.7,
  movement: 0.5,
  bubble: 14,
  tone: 7000,
  space: 0.4,
  echo: 0.18,
};

const GRID = 0.02;

/**
 * Continuous flowing water. A pink-noise source split into low/mid/high bands
 * models turbulence (its spectral slope is what distinguishes a river from a
 * waterfall), gently animated by an LFO. A dense stream of small high droplets
 * layered on top supplies the discrete "bubbling" detail.
 */
export class FlowVoice {
  private master: Tone.Gain;
  private meter: Tone.Meter;
  private dry: Tone.Gain;
  private reverbSend: Tone.Gain;
  private echoSend: Tone.Gain;
  private tone: Tone.Filter;

  private noise: Tone.Noise;
  private noiseLevel: Tone.Gain;
  private low: Tone.Filter;
  private mid: Tone.Filter;
  private high: Tone.Filter;
  private lowGain: Tone.Gain;
  private midGain: Tone.Gain;
  private highGain: Tone.Gain;
  private lfo: Tone.LFO;

  private bubbleBus: Tone.Gain;
  private pool: DropletPool;
  private params: FlowParams = { ...DEFAULT_FLOW };
  private scheduleId = -1;
  private started = false;
  private playing = false;

  constructor(output?: Tone.ToneAudioNode, echoBus?: Tone.ToneAudioNode, spaceBus?: Tone.ToneAudioNode) {
    this.master = new Tone.Gain(0);
    this.master.connect(output ?? Tone.getDestination());
    this.meter = new Tone.Meter({ smoothing: 0.9 });
    this.master.connect(this.meter);

    this.dry = new Tone.Gain(1).connect(this.master);

    // Post-fader sends (parallel to dry): shared Space reverb + El Capistan echo.
    this.reverbSend = new Tone.Gain(DEFAULT_FLOW.space);
    if (spaceBus) {
      this.master.connect(this.reverbSend);
      this.reverbSend.connect(spaceBus);
    }
    this.echoSend = new Tone.Gain(DEFAULT_FLOW.echo);
    if (echoBus) {
      this.master.connect(this.echoSend);
      this.echoSend.connect(echoBus);
    }

    this.tone = new Tone.Filter({ type: "lowpass", frequency: DEFAULT_FLOW.tone, rolloff: -12 });
    this.tone.connect(this.dry);

    // --- three-band turbulence bed ---
    this.lowGain = new Tone.Gain(DEFAULT_FLOW.lows).connect(this.tone);
    this.midGain = new Tone.Gain(DEFAULT_FLOW.mids).connect(this.tone);
    this.highGain = new Tone.Gain(DEFAULT_FLOW.highs).connect(this.tone);

    this.low = new Tone.Filter({ type: "lowpass", frequency: 250, rolloff: -24 }).connect(this.lowGain);
    this.mid = new Tone.Filter({ type: "bandpass", frequency: 700, Q: 0.7 }).connect(this.midGain);
    this.high = new Tone.Filter({ type: "highpass", frequency: 3000, rolloff: -12 }).connect(this.highGain);

    this.noiseLevel = new Tone.Gain(DEFAULT_FLOW.noise);
    this.noiseLevel.connect(this.low);
    this.noiseLevel.connect(this.mid);
    this.noiseLevel.connect(this.high);
    this.noise = new Tone.Noise("pink").connect(this.noiseLevel);

    // Turbulence shimmer: slowly sweep the mid band.
    this.lfo = new Tone.LFO({ frequency: DEFAULT_FLOW.movement, min: 450, max: 1100 });
    this.lfo.connect(this.mid.frequency);

    // --- bubbling micro-droplets ---
    this.bubbleBus = new Tone.Gain(0.5).connect(this.tone);
    this.pool = new DropletPool(this.bubbleBus, 24, 10);
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
    if (!this.started) {
      this.noise.start();
      this.lfo.start();
      this.pool.start();
      this.started = true;
    }
    const transport = Tone.getTransport();
    if (transport.state !== "started") transport.start();
    if (this.scheduleId < 0) {
      this.scheduleId = transport.scheduleRepeat((time) => this.tick(time), GRID);
    }
    this.playing = true;
    this.master.gain.rampTo(this.params.level, 0.8);
  }

  stop(): void {
    this.playing = false;
    this.master.gain.rampTo(0, 1);
  }

  async toggle(): Promise<boolean> {
    if (this.playing) this.stop();
    else await this.start();
    return this.playing;
  }

  applyParams(next: FlowParams): void {
    this.params = next;
    if (this.playing) this.master.gain.rampTo(next.level, 0.1);
    this.noiseLevel.gain.rampTo(next.noise, 0.1);
    this.lowGain.gain.rampTo(next.lows, 0.1);
    this.midGain.gain.rampTo(next.mids, 0.1);
    this.highGain.gain.rampTo(next.highs, 0.1);
    this.lfo.frequency.rampTo(next.movement, 0.1);
    this.tone.frequency.rampTo(next.tone, 0.1);
    this.reverbSend.gain.rampTo(next.space, 0.1);
    this.echoSend.gain.rampTo(next.echo, 0.1);
  }

  dispose(): void {
    if (this.scheduleId >= 0) Tone.getTransport().clear(this.scheduleId);
    this.lfo.dispose();
    this.noise.dispose();
    this.noiseLevel.dispose();
    this.low.dispose();
    this.mid.dispose();
    this.high.dispose();
    this.lowGain.dispose();
    this.midGain.dispose();
    this.highGain.dispose();
    this.pool.dispose();
    this.bubbleBus.dispose();
    this.tone.dispose();
    this.dry.dispose();
    this.reverbSend.dispose();
    this.echoSend.dispose();
    this.meter.dispose();
    this.master.dispose();
  }

  private tick(time: number): void {
    if (!this.playing) return;
    const expected = this.params.bubble * GRID;
    let count = Math.floor(expected);
    if (Math.random() < expected - count) count += 1;
    for (let i = 0; i < count; i += 1) {
      // Small, bright, fast droplets — the discrete detail riding on the bed.
      const freq = maybeQuantize(2200 * Math.pow(2, bipolar() * 0.8));
      this.pool.trigger(time + Math.random() * GRID, {
        freq,
        sweep: 1 + Math.random() * 0.8,
        decay: 0.03 + Math.random() * 0.05,
        amp: 0.18 + Math.random() * 0.22,
        transient: 0.5,
      });
    }
  }
}
