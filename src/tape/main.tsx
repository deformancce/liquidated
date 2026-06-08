import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MARKET_CONFIG, MARKETS } from "../config/markets";
import { HyperliquidClient } from "../data/hyperliquidClient";
import type { AssetContext, BboEvent, ConnectionStatus, Market, Side, TradeEvent } from "../types";
import "./tape.css";

type Mode = "raw" | "aggregated";

interface TapeRow {
  id: string;
  side: Side;
  price: number;
  quantity: number;
  usdSize: number;
  fills: number;
  startedAt: number;
  endedAt: number;
  liquidation: boolean;
}

// USD notional tiers, biggest first. Drives row colour intensity + big-print emphasis.
const TIERS = [
  { name: "rare", min: 1_000_000 },
  { name: "huge", min: 250_000 },
  { name: "significant", min: 50_000 },
  { name: "normal", min: 0 },
] as const;

const MIN_SIZE_OPTIONS = [0, 1_000, 10_000, 50_000, 100_000];
const MAX_ROWS_OPTIONS = [100, 200, 500];
const WINDOW_OPTIONS = [250, 500, 1_000];
const BUFFER_CAP = 1_000;
const MARKET_TAPE_PROFILE: Record<Market, { bucket: number; window: number; minSize: number }> = {
  BTC: { bucket: 1, window: 250, minSize: 0 },
  ETH: { bucket: 0.1, window: 250, minSize: 0 },
  SOL: { bucket: 0.01, window: 250, minSize: 0 },
  HYPE: { bucket: 0.01, window: 500, minSize: 0 },
};
const PRICE_BUCKET_OPTIONS_BY_MARKET: Record<Market, number[]> = {
  BTC: [0, 1, 2, 5],
  ETH: [0, 0.05, 0.1, 0.25, 0.5, 1],
  SOL: [0, 0.01, 0.05, 0.1, 0.25],
  HYPE: [0, 0.01, 0.05, 0.1, 0.25],
};

const tierOf = (usd: number) => TIERS.find((tier) => usd >= tier.min)?.name ?? "normal";

const money = (value: number) => {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K`;
  return `$${value.toFixed(0)}`;
};

const formatAge = (ms: number) => {
  const seconds = Math.max(0, Math.floor(ms / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h`;
};

const priceFmt = (market: Market, value: number) => value.toFixed(MARKET_CONFIG[market].priceDecimals);

function TapeApp() {
  const clientRef = useRef<HyperliquidClient | null>(null);
  const bufferRef = useRef<TapeRow[]>([]);
  const dirtyRef = useRef(false);
  const seqRef = useRef(0);

  const [market, setMarket] = useState<Market>("BTC");
  const [mode, setMode] = useState<Mode>("aggregated");
  const [minUsd, setMinUsd] = useState(0);
  const [maxRows, setMaxRows] = useState(200);
  const [windowMs, setWindowMs] = useState(250);
  const [priceBucket, setPriceBucket] = useState(1);
  const [status, setStatus] = useState<ConnectionStatus | "off">("off");
  const [rows, setRows] = useState<TapeRow[]>([]);
  const [now, setNow] = useState(() => Date.now());

  // Live config the trade handler reads without re-subscribing the socket.
  const cfgRef = useRef({ mode, windowMs, priceBucket });
  cfgRef.current = { mode, windowMs, priceBucket };

  const handleTrade = (trade: TradeEvent) => {
    const { mode: m, windowMs: w, priceBucket: bucket } = cfgRef.current;
    const buffer = bufferRef.current;
    const head = buffer[0];

    const canMerge =
      m === "aggregated" &&
      head &&
      head.side === trade.side &&
      !head.liquidation === !trade.liquidation &&
      trade.timestamp - head.endedAt <= w &&
      Math.abs(trade.price - head.price) <= bucket;

    if (canMerge) {
      const quantity = head.quantity + trade.quantity;
      const usdSize = head.usdSize + trade.size;
      buffer[0] = {
        ...head,
        price: quantity > 0 ? usdSize / quantity : trade.price,
        quantity,
        usdSize,
        fills: head.fills + 1,
        endedAt: trade.timestamp,
      };
    } else {
      seqRef.current += 1;
      buffer.unshift({
        id: `${trade.timestamp}-${seqRef.current}`,
        side: trade.side,
        price: trade.price,
        quantity: trade.quantity,
        usdSize: trade.size,
        fills: 1,
        startedAt: trade.timestamp,
        endedAt: trade.timestamp,
        liquidation: Boolean(trade.liquidation),
      });
      if (buffer.length > BUFFER_CAP) buffer.length = BUFFER_CAP;
    }
    dirtyRef.current = true;
  };

  // Reset stream + buffer when the market changes. Mode/window/bucket are read live,
  // but switching them should also clear so the tape doesn't mix aggregation regimes.
  useEffect(() => {
    bufferRef.current = [];
    dirtyRef.current = true;
    setRows([]);

    const client = new HyperliquidClient(market, {
      onTrade: handleTrade,
      onBbo: (_event: BboEvent) => {},
      onAssetContext: (_event: AssetContext) => {},
      onStatus: (next) => setStatus(next),
    });
    clientRef.current = client;
    client.connect();

    return () => client.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [market]);

  useEffect(() => {
    bufferRef.current = [];
    dirtyRef.current = true;
    setRows([]);
  }, [mode, windowMs, priceBucket]);

  // Flush buffer → state at 10fps, tick the age clock at 1s.
  useEffect(() => {
    const flush = window.setInterval(() => {
      if (!dirtyRef.current) return;
      dirtyRef.current = false;
      setRows(bufferRef.current.slice(0, BUFFER_CAP));
    }, 100);
    const clock = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => {
      window.clearInterval(flush);
      window.clearInterval(clock);
    };
  }, []);

  const visible = useMemo(
    () => rows.filter((row) => row.usdSize >= minUsd).slice(0, maxRows),
    [rows, minUsd, maxRows],
  );

  const stats = useMemo(() => {
    let buyUsd = 0;
    let sellUsd = 0;
    for (const row of visible) {
      if (row.side === "buy") buyUsd += row.usdSize;
      else sellUsd += row.usdSize;
    }
    return { buyUsd, sellUsd, delta: buyUsd - sellUsd };
  }, [visible]);

  const changeMarket = (next: Market) => {
    const profile = MARKET_TAPE_PROFILE[next];
    setMarket(next);
    setMinUsd(profile.minSize);
    setWindowMs(profile.window);
    setPriceBucket(profile.bucket);
  };

  return (
    <main className="tape-shell aggr">
      <header className="tape-head">
        <img className="brand-logo" src="/assets/liquidated_logo.svg" alt="Liquidated" />
        <a href="/synth.html">Synth →</a>
      </header>

      <section className="controls">
        <label>
          Coin
          <select value={market} onChange={(event) => changeMarket(event.target.value as Market)}>
            {MARKETS.map((item) => (
              <option key={item} value={item}>{item}</option>
            ))}
          </select>
        </label>

        <div className="seg" role="group" aria-label="Mode">
          {(["raw", "aggregated"] as Mode[]).map((value) => (
            <button
              key={value}
              type="button"
              className={mode === value ? "on" : ""}
              onClick={() => setMode(value)}
            >
              {value === "raw" ? "Raw" : "Aggregated"}
            </button>
          ))}
        </div>

        <label>
          Min size
          <select value={minUsd} onChange={(event) => setMinUsd(Number(event.target.value))}>
            {MIN_SIZE_OPTIONS.map((value) => (
              <option key={value} value={value}>{value === 0 ? "0" : money(value)}</option>
            ))}
          </select>
        </label>

        <label>
          Max rows
          <select value={maxRows} onChange={(event) => setMaxRows(Number(event.target.value))}>
            {MAX_ROWS_OPTIONS.map((value) => (
              <option key={value} value={value}>{value}</option>
            ))}
          </select>
        </label>

        <label className={mode === "raw" ? "disabled" : ""}>
          Window
          <select value={windowMs} disabled={mode === "raw"} onChange={(event) => setWindowMs(Number(event.target.value))}>
            {WINDOW_OPTIONS.map((value) => (
              <option key={value} value={value}>{value}ms</option>
            ))}
          </select>
        </label>

        <label className={mode === "raw" ? "disabled" : ""}>
          Price bucket
          <select value={priceBucket} disabled={mode === "raw"} onChange={(event) => setPriceBucket(Number(event.target.value))}>
            {PRICE_BUCKET_OPTIONS_BY_MARKET[market].map((value) => (
              <option key={value} value={value}>{value === 0 ? "exact" : `$${value}`}</option>
            ))}
          </select>
        </label>

        <span className={`status ${status === "live" ? "on" : ""}`}>{status}</span>
        <span className="spacer" />
        <span className="buy-stat">{money(stats.buyUsd)} buy</span>
        <span className="sell-stat">{money(stats.sellUsd)} sell</span>
        <span className={stats.delta >= 0 ? "buy-stat" : "sell-stat"}>
          Δ {stats.delta >= 0 ? "+" : "−"}{money(Math.abs(stats.delta))}
        </span>
      </section>

      <section className="tape">
        <div className="tape-row tape-header">
          <span>Side</span>
          <span className="num">Price</span>
          <span className="num">Size</span>
          <span className="num">{mode === "aggregated" ? "Fills" : ""}</span>
          <span className="num">Age</span>
        </div>
        <div className="tape-body">
          {visible.map((row) => (
            <div
              key={row.id}
              className={`tape-row ${row.side}${row.liquidation ? " liq" : ""}`}
              data-tier={tierOf(row.usdSize)}
            >
              <span className="side">{row.liquidation ? "LIQ " : ""}{row.side === "buy" ? "BUY" : "SELL"}</span>
              <span className="num price">{priceFmt(market, row.price)}</span>
              <span className="num size">{money(row.usdSize)}</span>
              <span className="num fills">{mode === "aggregated" && row.fills > 1 ? `×${row.fills}` : ""}</span>
              <span className="num age">{formatAge(now - row.endedAt)}</span>
            </div>
          ))}
          {!visible.length && (
            <div className="tape-empty">
              {status === "live" ? "Waiting for trades…" : "Connecting to Hyperliquid…"}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root element");

createRoot(container).render(
  <StrictMode>
    <TapeApp />
  </StrictMode>,
);
