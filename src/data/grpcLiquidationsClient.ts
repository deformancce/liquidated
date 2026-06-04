import type { LiquidationEvent, Market, Side } from "../types";

interface Callbacks {
  onLiquidation: (event: LiquidationEvent) => void;
  onSnapshot: (events: LiquidationEvent[]) => void;
  onStatus: (status: string) => void;
}

const DEFAULT_WS_URL = "ws://localhost:8787/ws";
const DEFAULT_HTTP_URL = "http://127.0.0.1:8787";
const MARKET_SET = new Set<Market>(["BTC", "ETH", "SOL", "HYPE"]);

export interface GrpcLiquidationsHealth {
  status: string;
  clients: number;
  recent: number;
  blocks: number;
  liquidations: number;
  last_block_time: string | null;
  last_error: string | null;
}

export class GrpcLiquidationsClient {
  private socket: WebSocket | null = null;
  private reconnectTimer = 0;
  private reconnects = 0;

  constructor(private callbacks: Callbacks, private endpoint = import.meta.env.VITE_LIQUIDATIONS_WS_URL || DEFAULT_WS_URL) {}

  connect(): void {
    this.disconnect();
    this.callbacks.onStatus("connecting");
    this.socket = new WebSocket(this.endpoint);

    this.socket.addEventListener("open", () => {
      this.reconnects = 0;
      this.callbacks.onStatus("live");
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
    let message: unknown;
    try {
      message = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isObject(message)) return;

    if (message.type === "snapshot" && Array.isArray(message.data)) {
      this.callbacks.onSnapshot(message.data.flatMap((event) => normalizeEvent(event) ?? []));
    }
    if (message.type === "liquidation") {
      const event = normalizeEvent(message.data);
      if (event) this.callbacks.onLiquidation(event);
    }
  }
}

export async function fetchGrpcLiquidationsHealth(endpoint = import.meta.env.VITE_LIQUIDATIONS_HTTP_URL || DEFAULT_HTTP_URL): Promise<GrpcLiquidationsHealth> {
  const response = await fetch(`${endpoint}/health`);
  if (!response.ok) throw new Error(`gRPC indexer health failed (${response.status})`);
  return response.json() as Promise<GrpcLiquidationsHealth>;
}

function normalizeEvent(value: unknown): LiquidationEvent | null {
  if (!isObject(value)) return null;
  const market = normalizeMarket(value.coin);
  const side = normalizeSide(value.side);
  const price = Number(value.price || 0);
  const size = Number(value.notional || 0);
  const quantity = Number(value.quantity || 0);
  const timestamp = Number(value.timestamp || Date.now());
  if (!market || !side || !Number.isFinite(size) || !Number.isFinite(timestamp)) return null;

  const markPrice = Number(value.markPrice);
  return {
    market,
    side,
    price: Number.isFinite(price) ? price : 0,
    markPrice: Number.isFinite(markPrice) ? markPrice : undefined,
    size,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    fills: 1,
    timestamp,
    method: typeof value.method === "string" ? value.method : undefined,
    kind: typeof value.direction === "string" ? value.direction : undefined,
    liquidatedUser: typeof value.liquidatedUser === "string" ? value.liquidatedUser : undefined,
    eventHash: typeof value.id === "string" ? value.id : undefined,
    source: "grpc",
  };
}

function normalizeMarket(value: unknown): Market | null {
  return typeof value === "string" && MARKET_SET.has(value as Market) ? value as Market : null;
}

function normalizeSide(value: unknown): Side | null {
  return value === "buy" || value === "sell" ? value : null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
