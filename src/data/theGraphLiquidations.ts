import type { LiquidationEvent, Market, Side } from "../types";

interface LiquidationsResponse {
  data?: unknown;
  error?: string;
}

const MARKET_SET = new Set<Market>(["BTC", "ETH", "SOL", "HYPE"]);

export async function fetchTheGraphLiquidations(market: Market, limit = 50): Promise<LiquidationEvent[]> {
  const params = new URLSearchParams({
    coin: market,
    limit: String(limit),
  });
  const response = await fetch(`/api/liquidations?${params.toString()}`);
  const payload = (await response.json().catch(() => ({}))) as LiquidationsResponse;

  if (!response.ok) {
    throw new Error(payload.error || `Liquidations request failed (${response.status})`);
  }

  if (!Array.isArray(payload.data)) return [];
  return payload.data.flatMap((row) => {
    const event = normalizeLiquidation(row);
    return event ? [event] : [];
  });
}

function normalizeLiquidation(row: unknown): LiquidationEvent | null {
  if (!isObject(row)) return null;

  const coin = String(row.coin || row.market_name || "");
  if (!MARKET_SET.has(coin as Market)) return null;

  const price = Number(row.avg_fill_price);
  const size = Number(row.notional);
  const quantity = Number(row.total_size);
  const timestamp = parseTimestamp(row.timestamp);
  const side = sideFromDirection(row.direction);
  if (!side || !Number.isFinite(price) || !Number.isFinite(size) || !Number.isFinite(quantity) || !timestamp) return null;

  const markPrice = Number(row.mark_price);
  return {
    market: coin as Market,
    side,
    price,
    markPrice: Number.isFinite(markPrice) ? markPrice : undefined,
    size,
    quantity,
    fills: Number(row.fills || 0),
    timestamp,
    method: typeof row.liquidation_method === "string" ? row.liquidation_method : undefined,
    kind: typeof row.liquidation_kind === "string" ? row.liquidation_kind : undefined,
    liquidatedUser: typeof row.liquidated_user === "string" ? row.liquidated_user : undefined,
    eventHash: typeof row.event_hash === "string" ? row.event_hash : undefined,
    source: "thegraph" as const,
  };
}

function sideFromDirection(value: unknown): Side | null {
  const direction = String(value || "").toUpperCase();
  if (direction.includes("LONG")) return "sell";
  if (direction.includes("SHORT")) return "buy";
  return null;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number") return value > 1e12 ? value : value * 1000;
  if (typeof value !== "string") return null;
  const millis = Date.parse(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  return Number.isFinite(millis) ? millis : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
