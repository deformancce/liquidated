export type Market = "BTC" | "ETH" | "SOL" | "HYPE";

export type Side = "buy" | "sell";

export type FlowSignalType =
  | "largeBuy"
  | "largeSell"
  | "buyCluster"
  | "sellCluster"
  | "effectiveBuy"
  | "effectiveSell"
  | "absorptionBid"
  | "absorptionAsk"
  | "cascadeRisk"
  | "volatilityPulse";

export type ConnectionStatus = "connecting" | "live" | "demo" | "reconnecting" | "error";

export interface TradeEvent {
  market: Market;
  side: Side;
  price: number;
  size: number;
  quantity: number;
  timestamp: number;
  source: "hyperliquid" | "demo";
}

export interface BboEvent {
  market: Market;
  bid: number;
  ask: number;
  mid: number;
  timestamp: number;
}

export interface AssetContext {
  market: Market;
  markPrice: number;
  oraclePrice: number;
  openInterest: number;
  funding: number;
  dayVolume: number;
  timestamp: number;
}

export interface FlowBucket {
  market: Market;
  startedAt: number;
  endedAt: number;
  buyVolume: number;
  sellVolume: number;
  tradeCount: number;
  largestTrade: TradeEvent | null;
  lastPrice: number;
  previousPrice: number;
  cvd: number;
}

export interface FlowSignal {
  type: FlowSignalType;
  market: Market;
  side: Side | "neutral";
  intensity: number;
  size: number;
  price: number;
  label: string;
  timestamp: number;
}

export interface ScannerSettings {
  market: Market;
  mode: "live" | "demo";
  minPrintSize: number;
  sensitivity: number;
  clusterWindowMs: number;
  volume: number;
  timbre: number;
  space: number;
  cascadeIntensity: number;
  viscosity: number;
  turbulence: number;
}
