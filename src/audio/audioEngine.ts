import { MARKET_CONFIG } from "../config/markets";
import { RingsWasmVoice } from "../resonator/ringsDspClient";
import type { FlowSignal, Market, ScannerSettings, Side, TradeEvent } from "../types";

type ResonatorMode = "modal" | "sympathetic" | "string";
type OutputMode = "odd" | "even" | "mix";

interface ResonatorTier {
  id: string;
  label: string;
  min: number;
  velocity: number;
  damping: number;
  brightness: number;
  spread: number;
  pitch: number;
}

interface ActivePlay {
  id: number;
  tier: string;
  side: Side;
  startedAt: number;
  stop?: (fadeMs?: number) => void;
  release: () => void;
  timer: number;
}

export interface ResonatorAudioParams {
  maxVoices: number;
  mode: ResonatorMode;
  output: OutputMode;
  baseFrequency: number;
  structure: number;
  brightness: number;
  baseDamping: number;
  basePosition: number;
  dampingLift: number;
  positionSpread: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

export const DEFAULT_RESONATOR_AUDIO: ResonatorAudioParams = {
  maxVoices: 18,
  mode: "modal",
  output: "mix",
  baseFrequency: 34,
  structure: 0.86,
  brightness: 0.25,
  baseDamping: 0.71,
  basePosition: 0.63,
  dampingLift: 0.14,
  positionSpread: 0.26,
  attack: 0.005,
  decay: 1.24,
  sustain: 0.24,
  release: 2.3,
};

const AGGR_GATE_MS = 90;
const MICRO_GATE_MS = 6;
const SIDE_VOICES = 3;
const D_MAJOR_PCS = [2, 4, 6, 7, 9, 11, 1];

// Micro-trade bundling: instead of offline-rendering one resonator buffer per
// tiny fill (which stalls the main thread under bursts), collect fills per side
// into a short window and render a few summed voices. Carpet from the resonator
// itself, bounded render count.
const MICRO_BUNDLE_MS = 90;
const MICRO_BUNDLE_LAYER_FILLS = 6; // a busy bundle adds one detuned voice

interface MicroBundle {
  side: Side;
  market: Market;
  sizeSum: number;
  pxSizeSum: number; // notional-weighted price accumulator
  count: number;
  lastTs: number;
}

/**
 * Liquidated-page audio: original Rings WASM, driven by the same trade events
 * as the fluid simulation. Buy = higher Odd core, sell = lower Even resonance.
 */
export class AudioEngine {
  private enabled = false;
  private ready = false;
  private voice: RingsWasmVoice | null = null;
  private settings: ScannerSettings | null = null;
  private params: ResonatorAudioParams = { ...DEFAULT_RESONATOR_AUDIO };
  private activePlays: ActivePlay[] = [];
  private playId = 0;
  private generation = 0;
  private gates = new Map<string, number>();
  private lastMicroAt = 0;
  private microBundles = new Map<Side, MicroBundle>();
  private microFlushTimer = 0;

  async toggle(settings: ScannerSettings): Promise<boolean> {
    return this.setEnabled(settings, !this.enabled);
  }

  async setEnabled(settings: ScannerSettings, enabled: boolean): Promise<boolean> {
    this.settings = settings;
    if (!enabled) {
      this.enabled = false;
      this.reset();
      return false;
    }
    await this.ensure();
    this.enabled = enabled;
    await this.voice?.resume();
    return this.enabled;
  }

  setSettings(settings: ScannerSettings): void {
    this.settings = settings;
    this.gates.clear();
  }

  setResonatorParams(next: Partial<ResonatorAudioParams>): void {
    this.params = { ...this.params, ...next };
    this.applyIdlePatch();
  }

  playTrade(trade: TradeEvent, options: { micro?: boolean } = {}): void {
    if (!this.enabled || !this.ready || !this.voice) return;
    // Tiny fills feed the bundler (one render per side per window); merged prints
    // and signals render straight away.
    if (options.micro) {
      this.bundleMicro(trade);
      return;
    }
    this.renderTrade(trade, { micro: false, fills: 1 });
  }

  /** Accumulate a micro fill into its side bundle; schedule a window flush. */
  private bundleMicro(trade: TradeEvent): void {
    const existing = this.microBundles.get(trade.side);
    const notional = trade.price * trade.size;
    if (existing) {
      existing.sizeSum += trade.size;
      existing.pxSizeSum += notional;
      existing.count += 1;
      existing.lastTs = trade.timestamp;
    } else {
      this.microBundles.set(trade.side, {
        side: trade.side,
        market: trade.market,
        sizeSum: trade.size,
        pxSizeSum: notional,
        count: 1,
        lastTs: trade.timestamp,
      });
    }
    if (!this.microFlushTimer) {
      this.microFlushTimer = window.setTimeout(() => this.flushMicroBundles(), MICRO_BUNDLE_MS);
    }
  }

  private flushMicroBundles(): void {
    this.microFlushTimer = 0;
    const bundles = [...this.microBundles.values()];
    this.microBundles.clear();
    if (!this.enabled || !this.ready) return;

    for (const bundle of bundles) {
      const price = bundle.pxSizeSum / Math.max(1e-9, bundle.sizeSum);
      const summed: TradeEvent = {
        market: bundle.market,
        side: bundle.side,
        price,
        size: bundle.sizeSum,
        quantity: 0,
        timestamp: bundle.lastTs,
        source: "hyperliquid",
      };
      this.renderTrade(summed, { micro: true, fills: bundle.count });
      // Busy bundles get a second, slightly detuned voice for a fuller carpet.
      if (bundle.count >= MICRO_BUNDLE_LAYER_FILLS) {
        const detune = bundle.side === "buy" ? 1.003 : 0.997;
        this.renderTrade(
          { ...summed, price: price * detune },
          { micro: true, fills: Math.ceil(bundle.count / 2) },
        );
      }
    }
  }

  private renderTrade(trade: TradeEvent, options: { micro: boolean; fills: number }): void {
    const settings = this.settings;
    if (!this.voice || !settings) return;
    const { micro, fills } = options;

    const minSize = micro ? Math.max(1, settings.minPrintSize) : Math.max(1_000, settings.minPrintSize);
    const maxSize = Math.max(minSize, settings.maxPrintSize ?? Number.POSITIVE_INFINITY);
    if (trade.size < minSize || trade.size > maxSize) return;

    const tiers = buildTiers(trade.market, minSize);
    const tierIndex = tierIndexForTrade(trade.size, tiers);
    const tier = tiers[tierIndex];
    if (!this.canPassAggrGate(trade, tier, micro)) return;
    this.makeRoomForVoice(tier, trade.side);
    if (!this.hasVoiceCapacity(tier, trade.side)) return;
    if (!canPlayTier(tier, this.params.maxVoices, this.activePlays.length)) return;

    const shaped = shapeForResonator(trade, tier, this.params, tiers[tierIndex + 1]);
    if (micro) {
      const audibility = Math.min(1, 0.34 + Math.log10(Math.max(1, trade.size)) / 7);
      const flurry = 1 + Math.min(0.7, Math.log10(fills + 1) * 0.5); // denser bundle = louder
      shaped.velocity = Math.max(0.12, Math.min(1, shaped.velocity * 0.46 * audibility * flurry));
      shaped.damping = Math.max(0.18, shaped.damping - 0.22);
      shaped.brightness = Math.min(0.98, shaped.brightness + 0.12);
      shaped.oddGain *= 0.62;
      shaped.evenGain *= 0.62;
    }
    const duration = effectivePlaybackDuration(durationForShape(tier, shaped, this.params, micro), this.params);
    const play = this.reserveVoice(tier, trade.side, duration);
    void this.playResonatorTrade(trade, tier, shaped, duration, play).catch(play.release);
  }

  playSignal(signal: FlowSignal): void {
    if (!this.enabled || signal.type !== "cascadeRisk") return;
    this.playTrade({
      market: signal.market,
      side: signal.side === "buy" ? "buy" : "sell",
      price: signal.price,
      size: signal.size * 1.4,
      quantity: 0,
      timestamp: signal.timestamp,
      source: "hyperliquid",
    });
  }

  getLevel(): number {
    return this.activePlays.length / Math.max(1, this.params.maxVoices);
  }

  reset(): void {
    for (const play of this.activePlays) {
      window.clearTimeout(play.timer);
      play.stop?.(30);
    }
    this.activePlays = [];
    this.generation += 1;
    this.gates.clear();
    this.microBundles.clear();
    if (this.microFlushTimer) {
      window.clearTimeout(this.microFlushTimer);
      this.microFlushTimer = 0;
    }
  }

  private async ensure(): Promise<void> {
    if (this.ready) return;
    this.voice = new RingsWasmVoice();
    await this.voice.init();
    this.ready = true;
    this.applyIdlePatch();
  }

  private applyIdlePatch(): void {
    this.voice?.setPatch({
      frequency: this.params.baseFrequency,
      structure: this.params.structure,
      brightness: this.params.brightness,
      damping: this.params.baseDamping,
      position: this.params.basePosition,
      frequencyCv: 0,
      structureCv: 0,
      brightnessCv: 0,
      dampingCv: 0,
      positionCv: 0,
      mode: this.params.mode,
    });
  }

  private canPassAggrGate(trade: TradeEvent, tier: ResonatorTier, micro = false): boolean {
    if (tier.id === "rare") return true;
    const multiplier = tier.id === "huge" ? 0.35 : tier.id === "significant" ? 0.65 : 1;
    const baseMs = micro ? MICRO_GATE_MS : AGGR_GATE_MS;
    const key = `${trade.side}:${tier.id}`;
    const now = performance.now();
    const last = this.gates.get(key) ?? 0;
    if (now - last < baseMs * multiplier) return false;
    this.gates.set(key, now);
    return true;
  }

  private hasVoiceCapacity(tier: ResonatorTier, side: Side): boolean {
    const sideLimit = tier.id === "threshold" || tier.id === "significant" ? SIDE_VOICES : SIDE_VOICES + 1;
    return this.activePlays.filter((play) => play.side === side).length < sideLimit;
  }

  private reserveVoice(tier: ResonatorTier, side: Side, duration: number): ActivePlay {
    const generation = this.generation;
    const id = this.playId += 1;
    let play: ActivePlay;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (generation !== this.generation) return;
      window.clearTimeout(play.timer);
      this.activePlays = this.activePlays.filter((active) => active.id !== id);
    };
    const timer = window.setTimeout(release, duration * 1000);
    play = { id, tier: tier.id, side, startedAt: performance.now(), release, timer };
    this.activePlays.push(play);
    return play;
  }

  private makeRoomForVoice(tier: ResonatorTier, side: Side): void {
    if (this.hasVoiceCapacity(tier, side) && canPlayTier(tier, this.params.maxVoices, this.activePlays.length)) return;

    const sideFull = !this.hasVoiceCapacity(tier, side);
    const now = performance.now();
    const candidates = this.activePlays
      .filter((play) => (!sideFull || play.side === side) && now - play.startedAt > 180)
      .sort((a, b) => {
        const priorityDelta = tierPriority(a.tier) - tierPriority(b.tier);
        if (priorityDelta !== 0) return priorityDelta;
        return a.startedAt - b.startedAt;
      });
    const victim = candidates.find((play) => tierPriority(play.tier) <= tierPriority(tier.id));
    if (!victim) return;

    window.clearTimeout(victim.timer);
    victim.stop?.(140);
    victim.release();
  }

  private async playResonatorTrade(
    trade: TradeEvent,
    tier: ResonatorTier,
    shaped: ReturnType<typeof shapeForResonator>,
    duration: number,
    play: ActivePlay,
  ): Promise<void> {
    const voice = this.voice;
    if (!voice) return;
    await voice.resume();
    voice.setPatch({
      frequency: this.params.baseFrequency,
      structure: Math.min(0.98, this.params.structure + shaped.velocity * 0.08),
      brightness: shaped.brightness,
      damping: shaped.damping,
      position: shaped.position,
      frequencyCv: 0,
      structureCv: 0,
      brightnessCv: 0,
      dampingCv: 0,
      positionCv: 0,
      mode: this.params.mode,
    });
    const rendered = voice.strum({
      output: this.params.output,
      vOct: shaped.vOct,
      velocity: shaped.velocity,
      exciter: Math.min(1, trade.size / tier.min / 2),
      duration,
      attack: this.params.attack,
      decay: this.params.decay,
      sustain: this.params.sustain,
      release: this.params.release,
      oddGain: shaped.oddGain,
      evenGain: shaped.evenGain,
    });
    play.stop = rendered.stop;
  }
}

function buildTiers(market: TradeEvent["market"], minSize: number): ResonatorTier[] {
  const config = MARKET_CONFIG[market];
  const significant = Math.max(minSize * 8, config.minPrintSize * 0.1);
  const huge = Math.max(minSize * 40, config.largePrintSize * 0.22);
  const rare = Math.max(minSize * 110, config.clusterSize * 0.35);
  return [
    { id: "threshold", label: "threshold", min: minSize, velocity: 0.24, damping: 0.02, brightness: 0, spread: 0.02, pitch: 0.16 },
    { id: "significant", label: "significant", min: significant, velocity: 0.42, damping: 0.08, brightness: 0.07, spread: 0.08, pitch: -0.04 },
    { id: "huge", label: "huge", min: huge, velocity: 0.68, damping: 0.16, brightness: 0.16, spread: 0.16, pitch: -0.28 },
    { id: "rare", label: "rare", min: rare, velocity: 0.94, damping: 0.25, brightness: 0.26, spread: 0.25, pitch: -0.52 },
  ];
}

function tierIndexForTrade(size: number, tiers: ResonatorTier[]) {
  for (let i = tiers.length - 1; i >= 0; i -= 1) {
    if (size >= tiers[i].min) return i;
  }
  return 0;
}

function canPlayTier(tier: ResonatorTier, maxVoices: number, activeVoices: number) {
  if (activeVoices < maxVoices) return true;
  if (tier.id === "rare") return activeVoices < maxVoices + 2;
  if (tier.id === "huge") return activeVoices < maxVoices + 1;
  return false;
}

function durationForShape(
  tier: ResonatorTier,
  shaped: { damping: number; velocity: number },
  params: ResonatorAudioParams,
  micro = false,
) {
  if (micro) {
    const microTail = tier.id === "huge" || tier.id === "rare" ? 0.55 : tier.id === "significant" ? 0.36 : 0.22;
    return Math.min(0.86, microTail + shaped.velocity * 0.16 + shaped.damping * 0.12);
  }
  const tierTail = tier.id === "rare" ? 2.35 : tier.id === "huge" ? 1.8 : tier.id === "significant" ? 1.15 : 0.7;
  const maxTail = tier.id === "rare" ? 4.2 : tier.id === "huge" ? 3.2 : 2.4;
  return Math.min(maxTail, tierTail + shaped.damping * 0.9 + shaped.velocity * 0.3 + params.release * 0.18);
}

function effectivePlaybackDuration(duration: number, params: ResonatorAudioParams) {
  const envelopeDuration =
    Math.max(0.02, params.attack) +
    Math.max(0.02, params.decay) +
    Math.max(0.02, params.release) +
    0.03;
  return Math.max(duration, envelopeDuration);
}

function tierPriority(tier: string) {
  if (tier === "rare") return 4;
  if (tier === "huge") return 3;
  if (tier === "significant") return 2;
  return 1;
}

function shapeForResonator(trade: TradeEvent, tier: ResonatorTier, params: ResonatorAudioParams, nextTier?: ResonatorTier) {
  const ratio = Math.min(4, Math.max(1, trade.size / tier.min));
  const energy = Math.sqrt(ratio) - 1;
  const tierProgress = nextTier
    ? Math.min(1, Math.max(0, (Math.log(trade.size) - Math.log(tier.min)) / (Math.log(nextTier.min) - Math.log(tier.min))))
    : Math.min(1, Math.max(0, Math.log(trade.size / tier.min) / Math.log(4)));
  const spread = Math.min(0.49, tier.spread + params.positionSpread * 0.35 + energy * 0.08);
  const directedPosition = trade.side === "buy" ? params.basePosition - spread : params.basePosition + spread;
  const sizeEnergy = Math.min(1, tier.velocity + energy * 0.45);
  const smallHalo = tier.id === "threshold" || tier.id === "significant" ? 0.12 : 0;
  const haloGain = Math.min(0.86, 0.16 + smallHalo + sizeEnergy * 0.58);
  const pricePitch = priceToVOct(trade);
  const sizePitch = tier.pitch - tierProgress * 0.1 - energy * 0.025;
  const sidePitch = trade.side === "buy" ? 0.22 : -0.2;
  const rawPitch = Math.max(-0.65, Math.min(0.35, pricePitch + sizePitch + sidePitch));
  return {
    velocity: Math.min(1, tier.velocity + energy * 0.24),
    damping: dampingForTier(tier, params, energy),
    brightness: Math.min(0.98, params.brightness + tier.brightness + energy * 0.04),
    position: Math.min(0.98, Math.max(0.02, directedPosition)),
    oddGain: trade.side === "buy" ? 1 : haloGain,
    evenGain: trade.side === "buy" ? haloGain : 1,
    vOct: quantizeDmajorVOct(rawPitch),
  };
}

function dampingForTier(tier: ResonatorTier, params: ResonatorAudioParams, energy: number) {
  const tierBias = tier.id === "rare"
    ? 0.18
    : tier.id === "huge"
      ? 0.11
      : tier.id === "significant"
        ? 0.02
        : -0.08;
  const sizeLift = Math.min(0.18, energy * 0.18);
  return Math.min(0.98, Math.max(0.18, params.baseDamping + tier.damping + tierBias + sizeLift));
}

function priceToVOct(trade: TradeEvent) {
  const config = MARKET_CONFIG[trade.market];
  const drift = Math.log2(trade.price / config.basePrice);
  return Math.max(-0.4, Math.min(0.4, drift * 0.35));
}

function quantizeDmajorVOct(vOct: number) {
  const targetSemis = vOct * 12;
  const center = Math.round(targetSemis);
  let best = center;
  let bestDistance = Infinity;
  for (let semis = center - 12; semis <= center + 12; semis += 1) {
    const pitchClass = (((69 + semis) % 12) + 12) % 12;
    if (!D_MAJOR_PCS.includes(pitchClass)) continue;
    const distance = Math.abs(semis - targetSemis);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = semis;
    }
  }
  return Math.max(-0.65, Math.min(0.35, best / 12));
}
