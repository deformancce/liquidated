import * as Tone from "tone";
import { DropletVoice, type DropletHit, type DropletParams, DEFAULT_DROPLET } from "./dropletVoice";
import { DEFAULT_SHARED_FX, type SharedFxParams } from "./sharedFxRack";

export interface TrackParams extends SharedFxParams {
  droplet: DropletParams;
}

export type TrackId = "main";

/**
 * One dry droplet source. Tracks now sum into a shared end-of-chain FX rack, so
 * market events do not allocate or automate separate pedalboards per track.
 */
export class DropletTrack {
  readonly voice: DropletVoice;
  private sum: Tone.Gain;

  constructor(master: Tone.ToneAudioNode, defaults: TrackParams) {
    this.sum = new Tone.Gain(1).connect(master);
    this.voice = new DropletVoice(this.sum);
    this.voice.applyParams(defaults.droplet);
  }

  setDroplet(next: DropletParams): void {
    this.voice.applyParams(next);
  }

  applyAll(params: TrackParams): void {
    this.setDroplet(params.droplet);
  }

  async toggle(): Promise<boolean> {
    return this.voice.toggle();
  }

  async start(): Promise<void> {
    await this.voice.start();
  }

  stop(): void {
    this.voice.stop();
  }

  triggerDrop(time?: number, hit?: DropletHit): void {
    this.voice.triggerDrop(time, hit);
  }

  getLevel(): number {
    return this.voice.getLevel();
  }

  dispose(): void {
    this.voice.dispose();
    this.sum.dispose();
  }
}

/**
 * Single droplet track. Buys splash in the upper pitch register, sells in the
 * lower one (handled in the feed mapping); `pitch` here is the overall tuning
 * centre the fader nudges.
 */
export const TRACK_DEFAULTS: Record<TrackId, TrackParams> = {
  main: {
    droplet: { ...DEFAULT_DROPLET, pitch: 900, decay: 0.08, spread: 0.5, space: 0.35, echo: 0.35, density: 4 },
    ...DEFAULT_SHARED_FX,
  },
};
