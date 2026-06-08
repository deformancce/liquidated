// WaterFeed: turns a stream of Hyperliquid TradeEvents into ripple "drops" for the
// GPU heightmap and into global bloom targets.
//
// Two clearly separated channels:
//   - per-drop (mouseSize + waveHeight + charge): one order / one aggregated tape line
//   - global bloom (strength + radius): rolling aggregate intensity of the whole feed
//
// Everything self-scales per market via running log-stats, so BTC/SOL/HYPE all work
// without hardcoded size thresholds.

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const lerp = (a, b, t) => a + (b - a) * t;

// How long consecutive same-side prints at ~the same price fold into one drop
const AGG_MS = 150;
const BASE_NOTIONAL = 1_000;
const MAX_VISUAL_NOTIONAL = 1_000_000;
const BASE_DROP_SIZE = 24;
const BASE_DROP_AMP = 0.45;

export class WaterFeed {
  /**
   * @param {object} opts
   * @param {number} opts.geomWidth  world width of the water plane
   * @param {number} opts.geomHeight world height of the water plane
   * @param {object} opts.marketConfig MARKET_CONFIG entry (for dust gating)
   */
  constructor({ geomWidth, geomHeight, marketConfig }) {
    this.geomWidth = geomWidth;
    this.geomHeight = geomHeight;
    this.minPrint = marketConfig ? marketConfig.minPrintSize : 50_000;

    // price -> X mapping bounds (self-recentering)
    this.priceLo = null;
    this.priceHi = null;

    // running log-notional stats for size normalization (EMA mean/var)
    this.lnMean = 0;
    this.lnVar = 1;
    this.lnInit = false;

    // tape aggregation accumulator
    this.agg = null; // { side, notional, count, price, firstTs }

    // queue of drops waiting to be fired on upcoming frames
    this.queue = [];

    // bloom state
    this.intensityFast = 0; // decaying sum of notional (~0.8s)
    this.slowAvg = 0;       // slow baseline (~12s)
    this.burst = 0;         // decaying max recent drop amplitude
  }

  // ---- ingestion -----------------------------------------------------------

  ingestTrade(trade) {
    const notional = trade.size; // already price * quantity (USD)
    if (!Number.isFinite(notional) || notional <= 0) return;

    this._trackPrice(trade.price);
    this._trackSizeStats(notional);
    this.intensityFast += notional;

    // fold into the current tape line, or flush + start a new one
    const a = this.agg;
    const priceTol = trade.price * 0.0005;
    if (
      a &&
      a.side === trade.side &&
      Math.abs(trade.price - a.price) <= priceTol &&
      trade.timestamp - a.firstTs < AGG_MS
    ) {
      a.notional += notional;
      a.count += 1;
      a.price = trade.price;
    } else {
      if (a) this._flush(a);
      this.agg = {
        side: trade.side,
        notional,
        count: 1,
        price: trade.price,
        firstTs: trade.timestamp,
      };
    }
  }

  // ---- per-frame consumption ----------------------------------------------

  /** Pop up to `max` drops to fire this frame. Each drop fires once. */
  collectDrops(max, now = Date.now()) {
    // time-based flush of a stale tape line
    if (this.agg && now - this.agg.firstTs >= AGG_MS) {
      this._flush(this.agg);
      this.agg = null;
    }
    if (this.queue.length === 0) return [];
    return this.queue.splice(0, Math.max(0, max));
  }

  /** Advance bloom decay and return current bloom targets. */
  bloomTargets(dt) {
    const step = Math.min(dt, 0.1);
    this.intensityFast *= Math.exp(-step / 0.8);
    this.burst *= Math.exp(-step / 0.8);
    // slow baseline tracks the fast intensity over ~12s
    this.slowAvg += (this.intensityFast - this.slowAvg) * (1 - Math.exp(-step / 12));

    const rel = this.slowAvg > 1 ? this.intensityFast / (this.slowAvg * 2.2) : 0;
    return {
      strength: 0.05 + 0.28 * clamp01(rel),
      radius: 0.005 + 0.055 * clamp01(this.burst / 1.5),
    };
  }

  priceToX(price) {
    if (this.priceLo === null || this.priceHi === null) return 0;
    const span = this.priceHi - this.priceLo;
    if (span <= 0) return 0;
    const n = (price - this.priceLo) / span; // 0..1
    return (clamp01(n) - 0.5) * this.geomWidth * 0.92;
  }

  priceToY(price) {
    if (this.priceLo === null || this.priceHi === null) return 0;
    const span = this.priceHi - this.priceLo;
    if (span <= 0) return 0;
    const n = (price - this.priceLo) / span; // 0..1
    return (clamp01(n) - 0.5) * this.geomHeight * 0.82;
  }

  // ---- internals -----------------------------------------------------------

  _flush(a) {
    const t = this._visualSizeNorm(a.notional);
    const aggBoost = 1 + Math.log2(Math.max(1, a.count)) * 0.25;
    const amp = lerp(BASE_DROP_AMP, 1.2, t) * aggBoost;
    const size = lerp(BASE_DROP_SIZE, 132, t);
    const sign = a.side === "buy" ? 1 : -1;
    const charge = sign * lerp(0.3, 1.2, t);

    // X: sells start left, buys start right. Larger trades move toward the center.
    // Y: price, so prints do not collapse into only two visual origins.
    const x = sign * lerp(0.42, 0.08, t) * this.geomWidth;
    const y = this.priceToY(a.price);

    this.burst = Math.max(this.burst, amp);
    this.queue.push({ x, y, size, amp, charge });
  }

  _trackPrice(price) {
    if (!Number.isFinite(price) || price <= 0) return;
    if (this.priceLo === null) {
      this.priceLo = price * 0.999;
      this.priceHi = price * 1.001;
      return;
    }
    // snap to new extremes fast, contract slowly so the range follows the market
    this.priceLo += (price - this.priceLo) * (price < this.priceLo ? 0.5 : 0.001);
    this.priceHi += (price - this.priceHi) * (price > this.priceHi ? 0.5 : 0.001);
  }

  _trackSizeStats(notional) {
    const ln = Math.log(Math.max(notional, 1));
    if (!this.lnInit) {
      this.lnMean = ln;
      this.lnVar = 1;
      this.lnInit = true;
      return;
    }
    const d = ln - this.lnMean;
    this.lnMean += d * 0.02;
    this.lnVar += (d * d - this.lnVar) * 0.02;
  }

  _sizeNorm(notional) {
    const ln = Math.log(Math.max(notional, 1));
    const sd = Math.sqrt(Math.max(this.lnVar, 1e-6));
    return clamp01(0.5 + (ln - this.lnMean) / (4 * sd)); // ~mean ± 2σ -> [0,1]
  }

  _visualSizeNorm(notional) {
    const safe = Math.max(notional, BASE_NOTIONAL);
    return clamp01(Math.log(safe / BASE_NOTIONAL) / Math.log(MAX_VISUAL_NOTIONAL / BASE_NOTIONAL));
  }
}
