import type { FlowBucket, Market, TradeEvent } from "../types";

export class FlowAggregator {
  private market: Market;
  private windowMs: number;
  private bucket: FlowBucket;
  private cvd = 0;

  constructor(market: Market, windowMs: number) {
    this.market = market;
    this.windowMs = windowMs;
    this.bucket = this.createBucket(Date.now(), 0, 0);
  }

  setMarket(market: Market): void {
    this.market = market;
    this.cvd = 0;
    this.bucket = this.createBucket(Date.now(), 0, 0);
  }

  setWindow(windowMs: number): void {
    this.windowMs = windowMs;
  }

  addTrade(trade: TradeEvent): FlowBucket | null {
    if (trade.timestamp - this.bucket.startedAt >= this.windowMs) {
      const completed = this.bucket.tradeCount > 0 ? { ...this.bucket } : null;
      this.bucket = this.createBucket(trade.timestamp, this.bucket.lastPrice, this.cvd);
      this.addToCurrent(trade);
      return completed;
    }

    this.addToCurrent(trade);
    return null;
  }

  snapshot(): FlowBucket {
    return { ...this.bucket };
  }

  private addToCurrent(trade: TradeEvent): void {
    if (trade.side === "buy") {
      this.bucket.buyVolume += trade.size;
      this.cvd += trade.size;
    } else {
      this.bucket.sellVolume += trade.size;
      this.cvd -= trade.size;
    }

    this.bucket.tradeCount += 1;
    this.bucket.endedAt = trade.timestamp;
    this.bucket.lastPrice = trade.price;
    this.bucket.cvd = this.cvd;

    if (!this.bucket.largestTrade || trade.size > this.bucket.largestTrade.size) {
      this.bucket.largestTrade = trade;
    }
  }

  private createBucket(startedAt: number, previousPrice: number, cvd: number): FlowBucket {
    return {
      market: this.market,
      startedAt,
      endedAt: startedAt,
      buyVolume: 0,
      sellVolume: 0,
      tradeCount: 0,
      largestTrade: null,
      lastPrice: previousPrice,
      previousPrice,
      cvd,
    };
  }
}
