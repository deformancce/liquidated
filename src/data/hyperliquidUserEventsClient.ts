import type { LiquidationEvent, Market, Side } from "../types";

type UserEventsStatus = "connecting" | "live" | "reconnecting" | "error";

interface Callbacks {
  onLiquidation: (event: LiquidationEvent) => void;
  onStatus: (status: UserEventsStatus) => void;
}

type HyperliquidMessage = {
  channel?: string;
  data?: unknown;
};

export class HyperliquidUserEventsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private reconnects = 0;

  constructor(
    private user: string,
    private fallbackMarket: Market,
    private callbacks: Callbacks,
    private endpoint = "wss://api.hyperliquid.xyz/ws",
  ) {}

  connect(): void {
    this.disconnect();
    this.callbacks.onStatus("connecting");
    this.socket = new WebSocket(this.endpoint);

    this.socket.addEventListener("open", () => {
      this.reconnects = 0;
      this.callbacks.onStatus("live");
      this.socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "userEvents", user: this.user } }));
      this.socket?.send(JSON.stringify({ method: "subscribe", subscription: { type: "userFills", user: this.user } }));
    });

    this.socket.addEventListener("message", (message) => {
      this.handleMessage(message.data);
    });

    this.socket.addEventListener("close", () => {
      if (this.socket) {
        this.callbacks.onStatus("reconnecting");
        this.scheduleReconnect();
      }
    });

    this.socket.addEventListener("error", () => {
      this.callbacks.onStatus("error");
      this.socket?.close();
    });
  }

  disconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    if (!this.socket) return;
    const socket = this.socket;
    this.socket = null;
    socket.close();
  }

  private scheduleReconnect(): void {
    const delay = Math.min(8_000, 700 + this.reconnects * 900);
    this.reconnects += 1;
    this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
  }

  private handleMessage(raw: string): void {
    let message: HyperliquidMessage;
    try {
      message = JSON.parse(raw) as HyperliquidMessage;
    } catch {
      return;
    }

    if (message.channel === "userEvents") {
      this.normalizeUserEvents(message.data).forEach(this.callbacks.onLiquidation);
    }

    if (message.channel === "userFills") {
      this.normalizeUserFills(message.data).forEach(this.callbacks.onLiquidation);
    }
  }

  private normalizeUserEvents(data: unknown): LiquidationEvent[] {
    const event = isObject(data) ? data : isObject(dataAt(data, "event")) ? dataAt(data, "event") : null;
    if (!isObject(event) || !isObject(event.liquidation)) return [];
    const liquidation = event.liquidation;
    const size = Number(liquidation.liquidated_ntl_pos);
    if (!Number.isFinite(size)) return [];

    return [{
      market: this.fallbackMarket,
      side: size < 0 ? "buy" : "sell",
      price: 0,
      size: Math.abs(size),
      quantity: 0,
      fills: 0,
      timestamp: Date.now(),
      liquidatedUser: stringOrUndefined(liquidation.liquidated_user),
      liquidator: stringOrUndefined(liquidation.liquidator),
      eventHash: String(liquidation.lid || `${this.user}:${Date.now()}`),
      source: "hyperliquid-user",
    }];
  }

  private normalizeUserFills(data: unknown): LiquidationEvent[] {
    if (!isObject(data) || !Array.isArray(data.fills)) return [];
    return data.fills.flatMap((fill) => {
      if (!isObject(fill) || !isObject(fill.liquidation)) return [];
      const market = normalizeMarket(fill.coin);
      const price = Number(fill.px);
      const quantity = Number(fill.sz);
      const side = sideFromFill(fill.dir, fill.side);
      const timestamp = Number(fill.time || Date.now());
      if (!market || !side || !Number.isFinite(price) || !Number.isFinite(quantity)) return [];

      const liquidation = fill.liquidation;
      const markPrice = Number(liquidation.markPx);
      return [{
        market,
        side,
        price,
        markPrice: Number.isFinite(markPrice) ? markPrice : undefined,
        size: price * quantity,
        quantity,
        fills: 1,
        timestamp,
        method: stringOrUndefined(liquidation.method),
        kind: typeof fill.dir === "string" ? fill.dir : undefined,
        liquidatedUser: stringOrUndefined(liquidation.liquidatedUser),
        eventHash: typeof fill.hash === "string" ? `${fill.hash}:${String(fill.tid || "")}` : undefined,
        source: "hyperliquid-user" as const,
      }];
    });
  }
}

function normalizeMarket(value: unknown): Market | null {
  return value === "BTC" || value === "ETH" || value === "SOL" || value === "HYPE" ? value : null;
}

function sideFromFill(dir: unknown, side: unknown): Side | null {
  const display = String(dir || "").toLowerCase();
  if (display.includes("close long")) return "sell";
  if (display.includes("close short")) return "buy";
  if (side === "B") return "buy";
  if (side === "A") return "sell";
  return null;
}

function dataAt(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
