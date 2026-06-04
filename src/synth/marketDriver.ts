import { MARKET_CONFIG } from "../config/markets";
import { DemoFeed } from "../data/demoFeed";
import { HyperliquidClient } from "../data/hyperliquidClient";
import { FlowAggregator } from "../flow/flowAggregator";
import { SignalEngine } from "../signals/signalEngine";
import type { ConnectionStatus, FlowSignal, Market, TradeEvent } from "../types";

export type FeedMode = "off" | "demo" | "live";
export type FeedShaping = "raw" | "aggregated";

interface DriverCallbacks {
  onTrade: (trade: TradeEvent) => void;
  onSignal: (signal: FlowSignal) => void;
  onStatus: (status: ConnectionStatus) => void;
  onRawTrade?: (trade: TradeEvent) => void;
  onAcceptedTrade?: (trade: TradeEvent) => void;
}

/**
 * Wraps the same Hyperliquid / demo feed the visualizer uses and turns the raw
 * trade stream into trades + flow signals (large prints, clusters, cascade
 * risk) for the synth to react to. The synth feeds those into one droplet voice
 * where buys splash in the upper pitch register and sells in the lower.
 */
export class MarketDriver {
  private market: Market;
  private mode: FeedMode = "off";
  private shaping: FeedShaping = "aggregated";
  private windowMs = 1_000;
  private priceBucket = 1;
  private sensitivity: number;
  private minOrderSize: number;
  private callbacks: DriverCallbacks;
  private aggregator: FlowAggregator;
  private signals: SignalEngine;
  private live: HyperliquidClient;
  private demo: DemoFeed;
  private currentTapePrint: TradeEvent | null = null;

  constructor(market: Market, callbacks: DriverCallbacks, sensitivity = 1) {
    this.market = market;
    this.callbacks = callbacks;
    this.sensitivity = sensitivity;
    this.minOrderSize = 1_000;
    this.aggregator = new FlowAggregator(market, 500);
    this.signals = new SignalEngine(market);
    this.demo = new DemoFeed(market, {
      onTrade: (t) => this.handleTrade(t),
      onBbo: (e) => this.signals.updateBbo(e),
    });
    this.live = new HyperliquidClient(market, {
      onTrade: (t) => this.handleTrade(t),
      onBbo: (e) => this.signals.updateBbo(e),
      onAssetContext: () => {},
      onStatus: (s) => this.callbacks.onStatus(s),
    });
  }

  setMode(mode: FeedMode): void {
    this.mode = mode;
    this.demo.stop();
    this.live.disconnect();
    this.currentTapePrint = null;
    if (mode === "demo") {
      this.callbacks.onStatus("demo");
      this.demo.start();
    } else if (mode === "live") {
      this.live.connect();
    }
  }

  setShaping(shaping: FeedShaping): void {
    this.shaping = shaping;
    this.currentTapePrint = null;
  }

  setWindow(windowMs: number): void {
    this.windowMs = Math.max(50, windowMs);
    this.currentTapePrint = null;
  }

  setPriceBucket(bucket: number): void {
    this.priceBucket = Math.max(0, bucket);
    this.currentTapePrint = null;
  }

  setMarket(market: Market): void {
    this.market = market;
    this.aggregator.setMarket(market);
    this.signals.setMarket(market);
    this.demo.setMarket(market);
    if (this.mode === "live") this.live.setMarket(market);
  }

  setMinOrderSize(value: number): void {
    this.minOrderSize = Math.max(0, value);
  }

  setSensitivity(value: number): void {
    this.sensitivity = value;
  }

  private handleTrade(trade: TradeEvent): void {
    this.callbacks.onRawTrade?.(trade);
    if (this.shaping === "raw") {
      this.handleAcceptedTrade(trade);
      return;
    }
    this.handleTapeAggregatedTrade(trade);
  }

  /** Aggregated mode: same head-merge semantics as the Tape page. */
  private handleTapeAggregatedTrade(trade: TradeEvent): void {
    const head = this.currentTapePrint;
    const canMerge =
      head &&
      head.side === trade.side &&
      trade.timestamp - head.timestamp <= this.windowMs &&
      (this.priceBucket === 0 ? head.price === trade.price : Math.abs(trade.price - head.price) <= this.priceBucket);

    if (canMerge) {
      const size = head.size + trade.size;
      const quantity = head.quantity + trade.quantity;
      this.currentTapePrint = {
        ...trade,
        price: quantity > 0 ? size / quantity : trade.price,
        size,
        quantity,
        timestamp: trade.timestamp,
      };
      return;
    }

    this.currentTapePrint = trade;
    this.handleAcceptedTrade(trade);
  }

  private handleAcceptedTrade(trade: TradeEvent): void {
    const minSize = this.minOrderSize;
    if (trade.size < minSize) return;

    this.callbacks.onAcceptedTrade?.(trade);
    this.callbacks.onTrade(trade);
    for (const signal of this.signals.fromTrade(trade, this.sensitivity)) {
      this.callbacks.onSignal(signal);
    }
    const completed = this.aggregator.addTrade(trade);
    if (completed) {
      for (const signal of this.signals.fromBucket(completed, this.sensitivity)) {
        this.callbacks.onSignal(signal);
      }
    }
  }

  dispose(): void {
    this.demo.stop();
    this.live.disconnect();
  }
}
