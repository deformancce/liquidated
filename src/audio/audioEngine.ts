import * as Tone from "tone";
import type { FlowSignal, ScannerSettings, TradeEvent } from "../types";
import { clamp } from "../utils/format";
import { DropletTrack, TRACK_DEFAULTS } from "../synth/dropletTrack";
import { DEFAULT_MASTER, MasterBus } from "../synth/masterBus";
import { SharedFxRack } from "../synth/sharedFxRack";
import { SELL_BAND, shapeTrade, TUNE_REF } from "../synth/tradeMapping";

/**
 * Visualizer audio. The same water-droplet engine as the Synth page — one
 * droplet voice through the shared FX rack — driven by the trade stream:
 * buys splash in the upper pitch register, sells in the lower, bigger prints
 * ring deeper (see ../synth/tradeMapping). Audio is toggled on/off; while on it
 * only sounds on trades/signals (no free-running density).
 */
export class AudioEngine {
  private enabled = false;
  private ready = false;
  private master: MasterBus | null = null;
  private fx: SharedFxRack | null = null;
  private track: DropletTrack | null = null;
  private baseDecay = TRACK_DEFAULTS.main.droplet.decay;
  private tune = 1;
  private floor = 1_000;

  async toggle(settings: ScannerSettings): Promise<boolean> {
    await this.ensure(settings);
    this.enabled = !this.enabled;
    this.setSettings(settings);
    if (this.enabled) await this.track?.start();
    else this.track?.stop();
    return this.enabled;
  }

  setSettings(settings: ScannerSettings): void {
    if (!this.ready) return;
    this.floor = Math.max(0, settings.minPrintSize);
    this.master?.applyParams({ ...DEFAULT_MASTER, master: clamp(0.3 + settings.volume, 0, 1) });

    // Volume → voice level, Timbre → brightness, Space → reverb send.
    const droplet = {
      ...TRACK_DEFAULTS.main.droplet,
      density: 0,
      level: this.enabled ? clamp(0.6 + settings.volume * 0.5, 0, 1) : 0,
      tone: 5000 + settings.timbre * 9000,
      space: settings.space,
    };
    this.baseDecay = droplet.decay;
    this.tune = droplet.pitch / TUNE_REF;
    this.track?.setDroplet(droplet);
  }

  playTrade(trade: TradeEvent): void {
    if (!this.enabled || !this.ready || !this.track) return;
    const shaped = shapeTrade(trade, { baseDecay: this.baseDecay, tune: this.tune, floor: this.floor });
    this.track.triggerDrop(undefined, { freq: shaped.freq, amp: shaped.amp, decay: shaped.decay });
    if (shaped.pulse > 0) this.fx?.pulse(shaped.pulse);
    if (shaped.second) this.track.triggerDrop(Tone.now() + 0.12, shaped.second);
  }

  playSignal(signal: FlowSignal): void {
    if (!this.enabled || !this.ready || !this.track) return;
    const boost = clamp(signal.intensity * 0.6, 0.25, 1.8);
    if (signal.type === "cascadeRisk" || signal.type.includes("absorption")) {
      this.track.triggerDrop(undefined, { freq: SELL_BAND.deep, amp: 0.95, decay: 0.4 });
    }
    this.fx?.pulse(boost);
  }

  getLevel(): number {
    return this.master?.getLevel() ?? 0;
  }

  private async ensure(settings: ScannerSettings): Promise<void> {
    if (this.ready) return;
    await Tone.start();
    const context = Tone.getContext();
    if (context.state !== "running") await context.resume();
    this.master = new MasterBus();
    this.fx = new SharedFxRack(this.master.input);
    this.track = new DropletTrack(this.fx.input, TRACK_DEFAULTS.main);
    this.ready = true;
    this.setSettings(settings);
  }
}
