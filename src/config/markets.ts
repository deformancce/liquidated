import type { Market } from "../types";

export interface MarketConfig {
  market: Market;
  minPrintSize: number;
  largePrintSize: number;
  clusterSize: number;
  priceDecimals: number;
  basePrice: number;
}

export const MARKET_CONFIG: Record<Market, MarketConfig> = {
  BTC: {
    market: "BTC",
    minPrintSize: 150_000,
    largePrintSize: 750_000,
    clusterSize: 1_500_000,
    priceDecimals: 1,
    basePrice: 68_000,
  },
  ETH: {
    market: "ETH",
    minPrintSize: 75_000,
    largePrintSize: 350_000,
    clusterSize: 850_000,
    priceDecimals: 2,
    basePrice: 3_800,
  },
  SOL: {
    market: "SOL",
    minPrintSize: 35_000,
    largePrintSize: 150_000,
    clusterSize: 400_000,
    priceDecimals: 3,
    basePrice: 170,
  },
  HYPE: {
    market: "HYPE",
    minPrintSize: 20_000,
    largePrintSize: 90_000,
    clusterSize: 240_000,
    priceDecimals: 3,
    basePrice: 30,
  },
};

export const MARKETS = Object.keys(MARKET_CONFIG) as Market[];
