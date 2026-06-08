import { StrictMode, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { HyperliquidClient } from "../data/hyperliquidClient";
import { MARKET_CONFIG, MARKETS } from "../config/markets";
import type { ConnectionStatus, Market, TradeEvent } from "../types";
import { money } from "../utils/format";
import { RingsWasmVoice } from "../resonator/ringsDspClient";
import "../resonator/resonator.css";
import "./resonator-live.css";

type ResonatorMode = "modal" | "sympathetic" | "string";
type OutputMode = "odd" | "even" | "mix";

interface LiveParams {
  market: Market;
  running: boolean;
  minSize: number;
  maxVoices: number;
  mode: ResonatorMode;
  output: OutputMode;
  baseFrequency: number;
  structure: number;
  brightness: number;
  baseDamping: number;
  basePosition: number;
  dampingLift: number;
  positionSpread: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
}

interface PlayedTrade {
  trade: TradeEvent;
  tier: ResonatorTier;
  damping: number;
  position: number;
  brightness: number;
  velocity: number;
  oddGain: number;
  evenGain: number;
  vOct: number;
}

interface ResonatorTier {
  id: string;
  label: string;
  min: number;
  velocity: number;
  damping: number;
  brightness: number;
  spread: number;
  pitch: number;
}

const MAX_ROWS = 18;
const AGGR_GATE_MS = 90;
const D_MAJOR_PCS = [2, 4, 6, 7, 9, 11, 1];

function defaults(market: Market): LiveParams {
  const config = MARKET_CONFIG[market];
  return {
    market,
    running: false,
    minSize: 1_000,
    maxVoices: 5,
    mode: "modal",
    output: "mix",
    baseFrequency: 34,
    structure: 0.77,
    brightness: 0.32,
    baseDamping: 0.71,
    basePosition: 0.63,
    dampingLift: 0.12,
    positionSpread: 0.18,
    attack: 0.005,
    decay: 1.24,
    sustain: 0.24,
    release: 1.34,
  };
}

function App() {
  const [params, setParams] = useState<LiveParams>(() => defaults("BTC"));
  const [status, setStatus] = useState<ConnectionStatus>("connecting");
  const [engine, setEngine] = useState("loading Rings WASM...");
  const [rawCount, setRawCount] = useState(0);
  const [skipped, setSkipped] = useState(0);
  const [activeVoices, setActiveVoices] = useState(0);
  const [played, setPlayed] = useState<PlayedTrade[]>([]);
  const [last, setLast] = useState<PlayedTrade | null>(null);
  const clientRef = useRef<HyperliquidClient | null>(null);
  const voiceRef = useRef<RingsWasmVoice | null>(null);
  const paramsRef = useRef(params);
  const lastPlayRef = useRef(0);
  const tierGateRef = useRef(new Map<string, number>());
  const rawCountRef = useRef(0);
  const skippedRef = useRef(0);
  const activeVoicesRef = useRef(0);
  const voiceGenerationRef = useRef(0);
  paramsRef.current = params;

  const tiers = useMemo(() => buildTiers(params.market, params.minSize), [params.market, params.minSize]);

  useEffect(() => {
    const voice = new RingsWasmVoice();
    voiceRef.current = voice;
    voice.init()
      .then(() => setEngine("Original Rings WASM active"))
      .catch((error) => setEngine(`Rings WASM failed: ${error instanceof Error ? error.message : "unknown"}`));
    return () => voice.dispose();
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      setRawCount(rawCountRef.current);
      setSkipped(skippedRef.current);
      setActiveVoices(activeVoicesRef.current);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    const client = new HyperliquidClient(params.market, {
      onTrade: handleTrade,
      onBbo: () => {},
      onAssetContext: () => {},
      onStatus: setStatus,
    });
    clientRef.current = client;
    client.connect();
    return () => client.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.market]);

  useEffect(() => {
    voiceRef.current?.setPatch({
      frequency: params.baseFrequency,
      structure: params.structure,
      brightness: params.brightness,
      damping: params.baseDamping,
      position: params.basePosition,
      frequencyCv: 0,
      structureCv: 0,
      brightnessCv: 0,
      dampingCv: 0,
      positionCv: 0,
      mode: params.mode,
    });
  }, [params]);

  function handleTrade(trade: TradeEvent) {
    rawCountRef.current += 1;
    const p = paramsRef.current;
    if (!p.running || trade.size < p.minSize) return;

    const localTiers = buildTiers(p.market, p.minSize);
    const tierIndex = tierIndexForTrade(trade.size, localTiers);
    const tier = localTiers[tierIndex];
    const isHighPriority = tier.id === "huge" || tier.id === "rare";
    if (!canPassAggrGate(trade, tier)) {
      skippedRef.current += 1;
      return;
    }
    if (!canPlayTier(tier, p.maxVoices, activeVoicesRef.current)) {
      skippedRef.current += 1;
      return;
    }
    if (isHighPriority) lastPlayRef.current = performance.now();

    const shaped = shapeForResonator(trade, tier, p, localTiers[tierIndex + 1]);
    const duration = durationForShape(tier, shaped, p);
    const releaseVoice = reserveVoice(duration);
    void playTrade(trade, tier, shaped, duration).catch(() => {
      skippedRef.current += 1;
      releaseVoice();
    });
  }

  function canPassAggrGate(trade: TradeEvent, tier: ResonatorTier) {
    if (tier.id === "rare") return true;
    const multiplier = tier.id === "huge" ? 0.35 : tier.id === "significant" ? 0.65 : 1;
    const gateMs = AGGR_GATE_MS * multiplier;
    const key = `${trade.side}:${tier.id}`;
    const now = performance.now();
    const lastGate = tierGateRef.current.get(key) ?? 0;
    if (now - lastGate < gateMs) return false;
    tierGateRef.current.set(key, now);
    return true;
  }

  function reserveVoice(duration: number) {
    const generation = voiceGenerationRef.current;
    activeVoicesRef.current += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      if (generation !== voiceGenerationRef.current) return;
      activeVoicesRef.current = Math.max(0, activeVoicesRef.current - 1);
    };
    const timer = window.setTimeout(release, duration * 1000);
    return () => {
      window.clearTimeout(timer);
      release();
    };
  }

  async function playTrade(
    trade: TradeEvent,
    tier: ResonatorTier,
    shaped: { damping: number; position: number; brightness: number; velocity: number; oddGain: number; evenGain: number; vOct: number },
    duration: number,
  ) {
    const voice = voiceRef.current;
    if (!voice) throw new Error("Rings voice is not ready");
    await voice.resume();
    voice.setPatch({
      frequency: paramsRef.current.baseFrequency,
      structure: Math.min(0.98, paramsRef.current.structure + shaped.velocity * 0.08),
      brightness: shaped.brightness,
      damping: shaped.damping,
      position: shaped.position,
      frequencyCv: 0,
      structureCv: 0,
      brightnessCv: 0,
      dampingCv: 0,
      positionCv: 0,
      mode: paramsRef.current.mode,
    });
    voice.strum({
      output: paramsRef.current.output,
      vOct: shaped.vOct,
      velocity: shaped.velocity,
      exciter: Math.min(1, trade.size / tier.min / 2),
      duration,
      attack: paramsRef.current.attack,
      decay: paramsRef.current.decay,
      sustain: paramsRef.current.sustain,
      release: paramsRef.current.release,
      oddGain: shaped.oddGain,
      evenGain: shaped.evenGain,
    });

    const row = { trade, tier, ...shaped };
    setLast(row);
    setPlayed((rows) => [row, ...rows].slice(0, MAX_ROWS));
  }

  function update<K extends keyof LiveParams>(key: K, value: LiveParams[K]) {
    setParams((prev) => ({ ...prev, [key]: value }));
  }

  function switchMarket(market: Market) {
    setParams((prev) => ({ ...defaults(market), running: prev.running, mode: prev.mode, output: prev.output }));
    setPlayed([]);
    setLast(null);
    setRawCount(0);
    setSkipped(0);
    rawCountRef.current = 0;
    skippedRef.current = 0;
    activeVoicesRef.current = 0;
    tierGateRef.current.clear();
    voiceGenerationRef.current += 1;
  }

  return (
    <main className="resonator-lab live-resonator">
      <header className="lab-head">
        <div>
          <p className="kicker">Hyperliquid live trades · Resonator mapping</p>
          <h1>Live Tier Strums</h1>
        </div>
        <a className="back-link" href="/resonator.html">Resonator Lab</a>
      </header>

      <section className="transport-bar live-toolbar">
        <label className="select-field">
          <span>Market</span>
          <select value={params.market} onChange={(event) => switchMarket(event.target.value as Market)}>
            {MARKETS.map((market) => <option key={market}>{market}</option>)}
          </select>
        </label>
        <button className={`play-btn ${params.running ? "on" : ""}`} type="button" onClick={() => update("running", !params.running)}>
          {params.running ? "Stop Live Strums" : "Start Live Strums"}
        </button>
        <label className="select-field">
          <span>Model</span>
          <select value={params.mode} onChange={(event) => update("mode", event.target.value as ResonatorMode)}>
            <option value="modal">Modal resonator</option>
            <option value="string">Modulated string</option>
            <option value="sympathetic">Sympathetic strings</option>
          </select>
        </label>
        <label className="select-field">
          <span>Output</span>
          <select value={params.output} onChange={(event) => update("output", event.target.value as OutputMode)}>
            <option value="mix">Odd + Even</option>
            <option value="odd">Odd only</option>
            <option value="even">Even only</option>
          </select>
        </label>
        <span className={`live-pill ${status}`}>{status}</span>
        <span className="live-pill">{engine}</span>
      </section>

      <section className="live-grid">
        <div className="live-panel">
          <h2>Mapping</h2>
          <p>
            Aggr-style side split: buy is a clearly higher Odd-core voice, sell is a clearly lower Even-resonance voice.
            Bigger tiers still pull both sides darker and widen the opposite output.
          </p>
          <div className="tier-stack">
            {tiers.map((tier) => (
              <div key={tier.id} className="tier-row">
                <span>{tier.label}</span>
                <b>{money(tier.min)}+</b>
                <i style={{ transform: `scaleX(${tier.damping})` }} />
              </div>
            ))}
          </div>
        </div>

        <div className="live-panel">
          <h2>Controls</h2>
          <Control label="Min size" value={params.minSize} min={1_000} max={MARKET_CONFIG[params.market].clusterSize * 2} step={1_000} format={money} onChange={(value) => update("minSize", value)} />
          <Control label="Max voices" value={params.maxVoices} min={2} max={16} step={1} format={(value) => `${Math.round(value)}`} onChange={(value) => update("maxVoices", value)} />
          <Control label="Frequency" value={params.baseFrequency} min={0} max={60} step={1} format={(value) => `${Math.round(value)} st`} onChange={(value) => update("baseFrequency", value)} />
          <Control label="Structure" value={params.structure} min={0} max={0.999} step={0.001} onChange={(value) => update("structure", value)} />
          <Control label="Base damping" value={params.baseDamping} min={0} max={0.98} step={0.01} onChange={(value) => update("baseDamping", value)} />
          <Control label="Base position" value={params.basePosition} min={0.02} max={0.98} step={0.01} onChange={(value) => update("basePosition", value)} />
          <Control label="Damping lift" value={params.dampingLift} min={0} max={0.35} step={0.01} onChange={(value) => update("dampingLift", value)} />
          <Control label="Position spread" value={params.positionSpread} min={0.05} max={0.48} step={0.01} onChange={(value) => update("positionSpread", value)} />
          <Control label="Brightness" value={params.brightness} min={0.1} max={0.95} step={0.01} onChange={(value) => update("brightness", value)} />
          <Control label="Release" value={params.release} min={0.1} max={4} step={0.05} format={(value) => `${value.toFixed(2)}s`} onChange={(value) => update("release", value)} />
        </div>

        <div className="live-panel live-readout">
          <h2>Now</h2>
          <div className="stat-row"><span>Raw trades</span><b>{rawCount}</b></div>
          <div className="stat-row"><span>Skipped</span><b>{skipped}</b></div>
          <div className="stat-row"><span>Voices</span><b>{activeVoices}/{params.maxVoices}</b></div>
          <div className="stat-row"><span>Played</span><b>{played.length}</b></div>
          <div className="last-hit">
            {last ? (
              <>
                <strong className={last.trade.side}>{last.trade.side.toUpperCase()} {last.tier.label}</strong>
                <span>{money(last.trade.size)} @ {formatPrice(last.trade.price, last.trade.market)}</span>
                <span>Damp {last.damping.toFixed(2)} · Pos {last.position.toFixed(2)} · Pitch {formatSemitones(last.vOct)}</span>
              </>
            ) : (
              <span>Waiting for qualifying trades...</span>
            )}
          </div>
        </div>
      </section>

      <section className="live-tape">
        <div className="tape-head"><span>Side</span><span>Tier</span><span>Price</span><span>Size</span><span>Pitch</span><span>Even</span></div>
        {played.map((row) => (
          <div className={`tape-row ${row.trade.side}`} key={`${row.trade.timestamp}-${row.trade.size}-${row.position}`}>
            <span>{row.trade.side}</span>
            <span>{row.tier.label}</span>
            <span>{formatPrice(row.trade.price, row.trade.market)}</span>
            <span>{money(row.trade.size)}</span>
            <span>{formatSemitones(row.vOct)}</span>
            <span>{row.evenGain.toFixed(2)}</span>
          </div>
        ))}
      </section>
    </main>
  );
}

function buildTiers(market: Market, minSize: number): ResonatorTier[] {
  const config = MARKET_CONFIG[market];
  return [
    { id: "threshold", label: "threshold", min: minSize, velocity: 0.24, damping: 0.02, brightness: 0.00, spread: 0.02, pitch: 0.16 },
    { id: "significant", label: "significant", min: Math.max(minSize * 2.5, config.largePrintSize * 0.55), velocity: 0.42, damping: 0.08, brightness: 0.07, spread: 0.08, pitch: -0.04 },
    { id: "huge", label: "huge", min: Math.max(minSize * 6, config.largePrintSize), velocity: 0.68, damping: 0.16, brightness: 0.16, spread: 0.16, pitch: -0.28 },
    { id: "rare", label: "rare", min: Math.max(minSize * 14, config.clusterSize), velocity: 0.94, damping: 0.25, brightness: 0.26, spread: 0.25, pitch: -0.52 },
  ];
}

function tierForTrade(size: number, tiers: ResonatorTier[]) {
  return tiers[tierIndexForTrade(size, tiers)];
}

function tierIndexForTrade(size: number, tiers: ResonatorTier[]) {
  for (let i = tiers.length - 1; i >= 0; i -= 1) {
    if (size >= tiers[i].min) return i;
  }
  return 0;
}

function canPlayTier(tier: ResonatorTier, maxVoices: number, activeVoices: number) {
  if (activeVoices < maxVoices) return true;
  if (tier.id === "rare") return activeVoices < maxVoices + 2;
  if (tier.id === "huge") return activeVoices < maxVoices + 1;
  return false;
}

function durationForShape(
  tier: ResonatorTier,
  shaped: { damping: number; velocity: number },
  params: LiveParams,
) {
  const tierTail = tier.id === "rare"
    ? 2.35
    : tier.id === "huge"
      ? 1.8
      : tier.id === "significant"
        ? 1.15
        : 0.7;
  const maxTail = tier.id === "rare" ? 4.2 : tier.id === "huge" ? 3.2 : 2.4;
  return Math.min(maxTail, tierTail + shaped.damping * 1.05 + shaped.velocity * 0.35 + params.release * 0.3);
}

function shapeForResonator(trade: TradeEvent, tier: ResonatorTier, params: LiveParams, nextTier?: ResonatorTier) {
  const ratio = Math.min(2.5, Math.max(1, trade.size / tier.min));
  const energy = Math.sqrt(ratio) - 1;
  const tierProgress = nextTier
    ? Math.min(1, Math.max(0, (Math.log(trade.size) - Math.log(tier.min)) / (Math.log(nextTier.min) - Math.log(tier.min))))
    : Math.min(1, Math.max(0, Math.log(trade.size / tier.min) / Math.log(4)));
  const spread = Math.min(0.49, tier.spread + params.positionSpread * 0.35 + energy * 0.08);
  const center = params.basePosition;
  const directedPosition = trade.side === "buy" ? center - spread : center + spread;
  const sizeEnergy = Math.min(1, tier.velocity + energy * 0.45);
  const coreGain = 1.0;
  const haloGain = Math.min(0.82, 0.16 + sizeEnergy * 0.58);
  const pricePitch = priceToVOct(trade);
  const sizePitch = tier.pitch - tierProgress * 0.1 - energy * 0.025;
  const sidePitch = trade.side === "buy" ? 0.22 : -0.2;
  const rawPitch = Math.max(-0.65, Math.min(0.35, pricePitch + sizePitch + sidePitch));
  return {
    velocity: Math.min(1, tier.velocity + energy * 0.24),
    damping: Math.min(0.98, params.baseDamping + params.dampingLift + tier.damping + energy * 0.06),
    brightness: Math.min(0.98, params.brightness + tier.brightness + energy * 0.04),
    position: Math.min(0.98, Math.max(0.02, directedPosition)),
    oddGain: trade.side === "buy" ? coreGain : haloGain,
    evenGain: trade.side === "buy" ? haloGain : coreGain,
    vOct: quantizeDmajorVOct(rawPitch),
  };
}

function priceToVOct(trade: TradeEvent) {
  const config = MARKET_CONFIG[trade.market];
  const drift = Math.log2(trade.price / config.basePrice);
  return Math.max(-0.4, Math.min(0.4, drift * 0.35));
}

function quantizeDmajorVOct(vOct: number) {
  const targetSemis = vOct * 12;
  const center = Math.round(targetSemis);
  let best = center;
  let bestDistance = Infinity;
  for (let semis = center - 12; semis <= center + 12; semis += 1) {
    const pitchClass = (((69 + semis) % 12) + 12) % 12;
    if (!D_MAJOR_PCS.includes(pitchClass)) continue;
    const distance = Math.abs(semis - targetSemis);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = semis;
    }
  }
  return Math.max(-0.65, Math.min(0.35, best / 12));
}

function formatPrice(price: number, market: Market) {
  return price.toFixed(MARKET_CONFIG[market].priceDecimals);
}

function formatSemitones(vOct: number) {
  const semis = vOct * 12;
  return `${semis >= 0 ? "+" : ""}${semis.toFixed(1)}st`;
}

function Control({
  label,
  value,
  min,
  max,
  step,
  format = (next: number) => next.toFixed(2),
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format?: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="live-control">
      <span>{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />
      <b>{format(value)}</b>
    </label>
  );
}

const container = document.getElementById("root");
if (!container) throw new Error("Missing #root");

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
