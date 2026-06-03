import * as Tone from "tone";
import { GranularEngine } from "../audio/granularEngine";

export interface GrainParams {
  // Granular core
  grainSize: number;
  density: number;
  overlap: number;
  position: number;
  spray: number;
  pitch: number; // semitones
  playbackRate: number;
  pitchSpray: number; // cents
  ampSpray: number;
  reverse: number; // 0 / 1 (fader, snaps)
  // Tone shaping
  filterCutoff: number;
  // Delay
  delayTime: number;
  delayFeedback: number;
  delayMix: number;
  // Reverb
  reverbDecay: number;
  reverbMix: number;
  // Output
  master: number;
}

export const DEFAULT_PARAMS: GrainParams = {
  grainSize: 0.12,
  density: 18,
  overlap: 0.06,
  position: 0.5,
  spray: 0.12,
  pitch: 0,
  playbackRate: 1,
  pitchSpray: 0,
  ampSpray: 0.15,
  reverse: 0,
  filterCutoff: 12000,
  delayTime: 0.25,
  delayFeedback: 0.38,
  delayMix: 0.2,
  reverbDecay: 4.5,
  reverbMix: 0.28,
  master: 0.7,
};

/**
 * Granular sample instrument: GranularEngine feeds a lowpass filter, then splits
 * into a dry bus plus parallel delay and reverb sends, all summed at the master.
 */
export class GrainSynth {
  private engine = new GranularEngine();
  private filter: Tone.Filter;
  private dry: Tone.Gain;
  private delaySend: Tone.Gain;
  private reverbSend: Tone.Gain;
  private delay: Tone.FeedbackDelay;
  private reverb: Tone.Reverb;
  private master: Tone.Gain;
  private meter: Tone.Meter;
  private params: GrainParams = { ...DEFAULT_PARAMS };
  private loaded = false;
  private playing = false;

  constructor() {
    this.master = new Tone.Gain(DEFAULT_PARAMS.master).toDestination();
    this.meter = new Tone.Meter({ smoothing: 0.85 });
    this.master.connect(this.meter);

    this.dry = new Tone.Gain(1).connect(this.master);
    this.delay = new Tone.FeedbackDelay({
      delayTime: DEFAULT_PARAMS.delayTime,
      feedback: DEFAULT_PARAMS.delayFeedback,
      wet: 1,
    }).connect(this.master);
    this.reverb = new Tone.Reverb({ decay: DEFAULT_PARAMS.reverbDecay, wet: 1 }).connect(this.master);

    this.delaySend = new Tone.Gain(DEFAULT_PARAMS.delayMix).connect(this.delay);
    this.reverbSend = new Tone.Gain(DEFAULT_PARAMS.reverbMix).connect(this.reverb);

    this.filter = new Tone.Filter({ type: "lowpass", frequency: DEFAULT_PARAMS.filterCutoff, rolloff: -24 });
    this.filter.connect(this.dry);
    this.filter.connect(this.delaySend);
    this.filter.connect(this.reverbSend);

    this.engine.connect(this.filter);
    this.applyParams(DEFAULT_PARAMS);
  }

  get isLoaded(): boolean {
    return this.loaded;
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

  async loadFile(file: File): Promise<void> {
    const arrayBuffer = await file.arrayBuffer();
    const decoded = await Tone.getContext().rawContext.decodeAudioData(arrayBuffer.slice(0));
    this.engine.load(decoded);
    this.loaded = true;
  }

  loadDemoBuffer(): void {
    this.engine.load(this.createDemoBuffer());
    this.loaded = true;
  }

  async start(): Promise<void> {
    if (!this.loaded || this.playing) return;
    await Tone.start();
    this.engine.start();
    this.playing = true;
  }

  stop(): void {
    this.engine.stop();
    this.playing = false;
  }

  async toggle(): Promise<boolean> {
    if (this.playing) this.stop();
    else await this.start();
    return this.playing;
  }

  applyParams(next: GrainParams): void {
    this.params = next;
    const detuneCents = next.pitch * 100;
    this.engine.setSettings({
      grainSize: next.grainSize,
      overlap: next.overlap,
      playbackRate: Math.max(0.05, next.playbackRate),
      detune: detuneCents,
      reverse: next.reverse >= 0.5,
      position: next.position,
      positionJitter: next.spray,
      density: next.density,
      pitchRandom: next.pitchSpray,
      ampRandom: next.ampSpray,
    });
    this.filter.frequency.rampTo(next.filterCutoff, 0.05);
    this.delay.delayTime.rampTo(next.delayTime, 0.05);
    this.delay.feedback.rampTo(next.delayFeedback, 0.05);
    this.delaySend.gain.rampTo(next.delayMix, 0.05);
    this.reverbSend.gain.rampTo(next.reverbMix, 0.05);
    this.reverb.decay = Math.max(0.1, next.reverbDecay);
    this.master.gain.rampTo(next.master, 0.05);
  }

  /** Reverse setting requires re-reading from the reversed buffer. */
  restartIfPlaying(): void {
    if (this.playing) this.engine.restart();
  }

  dispose(): void {
    this.engine.dispose();
    this.filter.dispose();
    this.dry.dispose();
    this.delaySend.dispose();
    this.reverbSend.dispose();
    this.delay.dispose();
    this.reverb.dispose();
    this.meter.dispose();
    this.master.dispose();
  }

  private createDemoBuffer(): AudioBuffer {
    const ctx = Tone.getContext().rawContext as unknown as BaseAudioContext;
    const sampleRate = ctx.sampleRate;
    const duration = 3;
    const buffer = ctx.createBuffer(1, Math.floor(sampleRate * duration), sampleRate);
    const data = buffer.getChannelData(0);
    const partials = [110, 165, 220, 277, 330];
    for (let i = 0; i < data.length; i += 1) {
      const t = i / sampleRate;
      let sample = 0;
      partials.forEach((freq, index) => {
        const env = Math.exp(-((t - index * 0.5) ** 2) / 0.18);
        sample += Math.sin(2 * Math.PI * freq * t) * env * (1 / (index + 1));
      });
      sample += (Math.random() * 2 - 1) * 0.04;
      data[i] = Math.max(-1, Math.min(1, sample * 0.5));
    }
    return buffer;
  }
}
