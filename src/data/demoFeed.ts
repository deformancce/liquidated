import { MARKET_CONFIG } from "../config/markets";
import type { BboEvent, Market, TradeEvent } from "../types";

interface DemoFeedCallbacks {
  onTrade: (event: TradeEvent) => void;
  onBbo: (event: BboEvent) => void;
}

export class DemoFeed {
  private timer = 0;
  private market: Market;
  private callbacks: DemoFeedCallbacks;
  private price: number;

  constructor(market: Market, callbacks: DemoFeedCallbacks) {
    this.market = market;
    this.callbacks = callbacks;
    this.price = MARKET_CONFIG[market].basePrice;
  }

  start(): void {
    this.stop();
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 85);
  }

  stop(): void {
    window.clearInterval(this.timer);
    this.timer = 0;
  }

  setMarket(market: Market): void {
    this.market = market;
    this.price = MARKET_CONFIG[market].basePrice;
  }

  private tick(): void {
    const config = MARKET_CONFIG[this.market];
    const side = Math.random() > 0.52 ? "buy" : "sell";
    const clusterBoost = Math.random() > 0.86 ? 6 : 1;
    const size = (config.minPrintSize * 1.08 + Math.pow(Math.random(), 1.8) * config.largePrintSize) * clusterBoost;
    const drift = side === "buy" ? 1 : -1;

    this.price *= 1 + drift * Math.random() * 0.00045 * clusterBoost + (Math.random() - 0.5) * 0.00035;

    this.callbacks.onTrade({
      market: this.market,
      side,
      price: this.price,
      size,
      quantity: size / this.price,
      timestamp: Date.now(),
      source: "demo",
    });

    const spread = this.price * 0.00012;
    this.callbacks.onBbo({
      market: this.market,
      bid: this.price - spread,
      ask: this.price + spread,
      mid: this.price,
      timestamp: Date.now(),
    });
  }
}
