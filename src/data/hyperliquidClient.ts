import type { AssetContext, BboEvent, Market, TradeEvent } from "../types";

type HyperliquidMessage = {
  channel?: string;
  data?: unknown;
};

interface Callbacks {
  onTrade: (event: TradeEvent) => void;
  onBbo: (event: BboEvent) => void;
  onAssetContext: (event: AssetContext) => void;
  onStatus: (status: "connecting" | "live" | "reconnecting" | "error") => void;
}

export class HyperliquidClient {
  private socket: WebSocket | null = null;
  private market: Market;
  private reconnectTimer = 0;
  private reconnects = 0;
  private callbacks: Callbacks;
  private endpoint: string;
  private status: "idle" | "connecting" | "live" | "reconnecting" | "error" = "idle";

  constructor(market: Market, callbacks: Callbacks, endpoint = "wss://api.hyperliquid.xyz/ws") {
    this.market = market;
    this.callbacks = callbacks;
    this.endpoint = endpoint;
  }

  connect(force = false): void {
    if (!force && this.socket && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.disconnect();
    this.setStatus("connecting");
    const socket = new WebSocket(this.endpoint);
    this.socket = socket;

    socket.addEventListener("open", () => {
      if (this.socket !== socket) return;
      this.reconnects = 0;
      this.setStatus("live");
      this.subscribe();
    });

    socket.addEventListener("message", (message) => {
      if (this.socket !== socket) return;
      this.handleMessage(message.data);
    });

    socket.addEventListener("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.setStatus("reconnecting");
      this.scheduleReconnect();
    });

    socket.addEventListener("error", () => {
      if (this.socket !== socket) return;
      this.setStatus("error");
      socket.close();
    });
  }

  setMarket(market: Market): void {
    if (this.market === market) return;
    this.market = market;
    this.connect(true);
  }

  disconnect(): void {
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = 0;
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

  private setStatus(status: "connecting" | "live" | "reconnecting" | "error"): void {
    if (this.status === status) return;
    this.status = status;
    this.callbacks.onStatus(status);
  }

  private subscribe(): void {
    const subscriptions = [
      { type: "trades", coin: this.market },
      { type: "bbo", coin: this.market },
      { type: "activeAssetCtx", coin: this.market },
    ];

    for (const subscription of subscriptions) {
      this.socket?.send(JSON.stringify({ method: "subscribe", subscription }));
    }
  }

  private handleMessage(raw: string): void {
    let message: HyperliquidMessage;
    try {
      message = JSON.parse(raw) as HyperliquidMessage;
    } catch {
      return;
    }

    if (message.channel === "trades") {
      this.normalizeTrades(message.data).forEach(this.callbacks.onTrade);
    }

    if (message.channel === "bbo") {
      const bbo = this.normalizeBbo(message.data);
      if (bbo) this.callbacks.onBbo(bbo);
    }

    if (message.channel === "activeAssetCtx") {
      const context = this.normalizeAssetContext(message.data);
      if (context) this.callbacks.onAssetContext(context);
    }
  }

  private normalizeTrades(data: unknown): TradeEvent[] {
    if (!Array.isArray(data)) return [];

    return data.flatMap((trade) => {
      if (!isObject(trade)) return [];
      const price = Number(trade.px);
      const quantity = Number(trade.sz);
      const side = trade.side === "B" ? "buy" : trade.side === "A" ? "sell" : null;
      const timestamp = Number(trade.time || Date.now());

      if (!Number.isFinite(price) || !Number.isFinite(quantity) || !side) return [];

      return {
        market: this.market,
        side,
        price,
        size: price * quantity,
        quantity,
        timestamp,
        source: "hyperliquid" as const,
        liquidation: normalizeLiquidation(trade.liquidation),
      };
    });
  }

  private normalizeBbo(data: unknown): BboEvent | null {
    if (!isObject(data)) return null;
    const levels = Array.isArray(data.bbo) ? data.bbo : [];
    const bid = firstPrice(levels[0]);
    const ask = firstPrice(levels[1]);
    if (!bid || !ask) return null;

    return {
      market: this.market,
      bid,
      ask,
      mid: (bid + ask) / 2,
      timestamp: Number(data.time || Date.now()),
    };
  }

  private normalizeAssetContext(data: unknown): AssetContext | null {
    if (!isObject(data) || !isObject(data.ctx)) return null;
    const context = data.ctx;
    const markPrice = Number(context.markPx);
    const oraclePrice = Number(context.oraclePx);

    return {
      market: this.market,
      markPrice,
      oraclePrice,
      openInterest: Number(context.openInterest || 0),
      funding: Number(context.funding || 0),
      dayVolume: Number(context.dayNtlVlm || 0),
      timestamp: Date.now(),
    };
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function firstPrice(value: unknown): number | null {
  if (!isObject(value)) return null;
  const price = Number(value.px);
  return Number.isFinite(price) ? price : null;
}

function normalizeLiquidation(value: unknown): TradeEvent["liquidation"] {
  if (!isObject(value)) return undefined;
  const markPrice = Number(value.markPx);
  return {
    markPrice: Number.isFinite(markPrice) ? markPrice : undefined,
    method: typeof value.method === "string" ? value.method : undefined,
    liquidatedUser: typeof value.liquidatedUser === "string" ? value.liquidatedUser : undefined,
  };
}
