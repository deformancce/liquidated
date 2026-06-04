import type { Side, TradeEvent } from "../types";
import { clamp } from "../utils/format";

/**
 * Shared trade → droplet shaping, used by both the Synth page and the
 * visualizer's audio engine so the two never drift. A print is staged into one
 * of the aggr-style notional tiers (amp / ring length / FX pulse), then mapped
 * onto a pitch: buys splash in the upper register, sells in the lower, and a
 * bigger print rings deeper within its band.
 */
export interface OrderSizeTier {
  id: "threshold" | "significant" | "huge" | "rare";
  amount: number;
  amp: number;
  decay: number;
  pulse: number;
}

export const ORDER_SIZE_TIERS = [
  { id: "threshold", amount: 1_000, amp: 0.35, decay: 0.8, pulse: 0 },
  { id: "significant", amount: 10_000, amp: 0.55, decay: 1.15, pulse: 0.35 },
  { id: "huge", amount: 30_000, amp: 0.78, decay: 1.45, pulse: 0.8 },
  { id: "rare", amount: 100_000, amp: 1.05, decay: 1.85, pulse: 1.35 },
] satisfies OrderSizeTier[];

export const tierForSize = (size: number): OrderSizeTier => {
  let tier = ORDER_SIZE_TIERS[0];
  for (const candidate of ORDER_SIZE_TIERS) {
    if (size >= candidate.amount) tier = candidate;
  }
  return tier;
};

// Continuous size shaping on top of the discrete tiers.
export const SIZE_SOFT_CAP = 250_000; // notional at which pitch-drop / gate saturate

/** 0 at the order-size floor, 1 once a print reaches SIZE_SOFT_CAP. */
export const sizeMagnitude = (size: number, floor: number): number => {
  const span = Math.max(1, SIZE_SOFT_CAP - floor);
  return clamp((size - floor) / span, 0, 1);
};

// One voice, two registers: buys in the upper part of the spectrum, sells in
// the lower. Within each register a bigger print rings lower; buys stay above
// sells. `pitch` retunes everything relative to TUNE_REF.
export const TUNE_REF = 900;
export const BUY_BAND = { bright: 2600, deep: 820 };
export const SELL_BAND = { bright: 520, deep: 95 };

export const sideFreq = (side: Side, mag: number): number => {
  const band = side === "buy" ? BUY_BAND : SELL_BAND;
  return band.bright * Math.pow(band.deep / band.bright, Math.sqrt(mag));
};

export interface DropletHitShape {
  freq: number;
  amp: number;
  decay: number;
}

export interface TradeShaping extends DropletHitShape {
  tier: OrderSizeTier;
  mag: number; // continuous 0..1 size mass used by audio + visuals
  visual: {
    radius: number;
    spread: number;
    force: number;
    particles: number;
  };
  pulse: number; // shared-FX swell amount (0 = none)
  second: DropletHitShape | null; // heavy prints get a deeper second splash
}

export interface ShapeOptions {
  baseDecay: number; // track droplet decay
  tune?: number; // pitch retune multiplier (default 1)
  floor?: number; // order-size floor for size magnitude (default 0)
}

/** Turn a trade into the droplet hit(s) to play. Pure — no audio side effects. */
export function shapeTrade(trade: TradeEvent, opts: ShapeOptions): TradeShaping {
  const { baseDecay, tune = 1, floor = 0 } = opts;
  const tier = tierForSize(trade.size);
  const ratio = clamp(trade.size / tier.amount, 1, 4);
  const amp = clamp(tier.amp * Math.sqrt(ratio), 0.25, 1.25);

  const mag = sizeMagnitude(trade.size, floor);
  const visualMass = clamp(Math.log10(Math.max(1, trade.size)) / Math.log10(SIZE_SOFT_CAP), 0.08, 1.35);
  const freq = tune * sideFreq(trade.side, mag);
  const decay = baseDecay * tier.decay * (0.6 + mag * 1.1);
  const pulse = tier.pulse > 0 ? tier.pulse * Math.min(1.5, Math.sqrt(ratio)) : 0;
  const visual = {
    radius: clamp(0.65 + visualMass * 4.8 + Math.sqrt(ratio) * 0.42 + tier.pulse * 0.34, 1.05, 7.2),
    spread: clamp(0.8 + visualMass * 5.1 + tier.pulse * 0.58, 1.0, 7.5),
    force: clamp(0.9 + visualMass * 5.8 + pulse * 0.9, 1.2, 8.8),
    particles: Math.round(clamp(3 + visualMass * 48 + tier.pulse * 14, 4, 88)),
  };
  const second =
    tier.id === "huge" || tier.id === "rare"
      ? { freq: freq * 0.5, amp: amp * 0.72, decay: decay * 0.85 }
      : null;

  return { tier, mag, amp, freq, decay, visual, pulse, second };
}
