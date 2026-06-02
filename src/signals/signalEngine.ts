import { MARKET_CONFIG } from "../config/markets";
import { clamp } from "../utils/format";
import type { BboEvent, FlowBucket, FlowSignal, Market, TradeEvent } from "../types";

export class SignalEngine {
  private market: Market;
  private lastMid = 0;

  constructor(market: Market) {
    this.market = market;
  }

  setMarket(market: Market): void {
    this.market = market;
    this.lastMid = 0;
  }

  updateBbo(event: BboEvent): void {
    this.lastMid = event.mid;
  }

  fromTrade(trade: TradeEvent, sensitivity: number): FlowSignal[] {
    const config = MARKET_CONFIG[trade.market];
    if (trade.size < config.largePrintSize) return [];

    const side = trade.side;
    const intensity = clamp((trade.size / config.largePrintSize) * sensitivity, 0.2, 3.5);
    return [
      {
        type: side === "buy" ? "largeBuy" : "largeSell",
        market: trade.market,
        side,
        intensity,
        size: trade.size,
        price: trade.price,
        label: side === "buy" ? "Large Buy" : "Large Sell",
        timestamp: trade.timestamp,
      },
    ];
  }

  fromBucket(bucket: FlowBucket, sensitivity: number): FlowSignal[] {
    const config = MARKET_CONFIG[bucket.market];
    const signals: FlowSignal[] = [];
    const dominantSide = bucket.buyVolume >= bucket.sellVolume ? "buy" : "sell";
    const dominantVolume = Math.max(bucket.buyVolume, bucket.sellVolume);
    const totalVolume = bucket.buyVolume + bucket.sellVolume;
    const priceMove = bucket.lastPrice - bucket.previousPrice;
    const direction = priceMove > 0 ? "buy" : priceMove < 0 ? "sell" : "neutral";
    const dominance = totalVolume ? Math.abs(bucket.buyVolume - bucket.sellVolume) / totalVolume : 0;
    const intensity = clamp((dominantVolume / config.clusterSize) * sensitivity, 0, 4);

    if (dominantVolume >= config.clusterSize && dominance > 0.28) {
      signals.push({
        type: dominantSide === "buy" ? "buyCluster" : "sellCluster",
        market: bucket.market,
        side: dominantSide,
        intensity,
        size: dominantVolume,
        price: bucket.lastPrice,
        label: dominantSide === "buy" ? "Buy Cluster" : "Sell Cluster",
        timestamp: bucket.endedAt,
      });
    }

    if (dominantVolume >= config.clusterSize * 0.7 && dominance > 0.22 && direction === dominantSide) {
      signals.push({
        type: dominantSide === "buy" ? "effectiveBuy" : "effectiveSell",
        market: bucket.market,
        side: dominantSide,
        intensity: clamp(intensity * 0.8, 0.2, 3),
        size: dominantVolume,
        price: bucket.lastPrice,
        label: dominantSide === "buy" ? "Effective Buy" : "Effective Sell",
        timestamp: bucket.endedAt,
      });
    }

    if (dominantVolume >= config.clusterSize * 0.55 && dominance > 0.24 && direction !== dominantSide) {
      signals.push({
        type: dominantSide === "sell" ? "absorptionBid" : "absorptionAsk",
        market: bucket.market,
        side: dominantSide === "sell" ? "buy" : "sell",
        intensity: clamp(intensity, 0.2, 3),
        size: dominantVolume,
        price: this.lastMid || bucket.lastPrice,
        label: dominantSide === "sell" ? "Bid Absorption" : "Ask Absorption",
        timestamp: bucket.endedAt,
      });
    }

    if (dominantVolume >= config.clusterSize * 1.6 && bucket.tradeCount >= 4 && Math.abs(priceMove / bucket.lastPrice) > 0.00045) {
      signals.push({
        type: "cascadeRisk",
        market: bucket.market,
        side: dominantSide,
        intensity: clamp(intensity * 1.25, 0.4, 4.5),
        size: dominantVolume,
        price: bucket.lastPrice,
        label: "Cascade Risk",
        timestamp: bucket.endedAt,
      });
    }

    return signals;
  }
}
