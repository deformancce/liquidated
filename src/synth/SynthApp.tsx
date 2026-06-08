import { useEffect, useRef, useState } from "react";
import { Fader, type FaderSpec } from "./Fader";
import { MarketDriver, type FeedMode, type FeedShaping } from "./marketDriver";
import { AudioEngine, DEFAULT_RESONATOR_AUDIO, type ResonatorAudioParams } from "../audio/audioEngine";
import { MARKETS } from "../config/markets";
import { LiquidRenderer } from "../visual/liquidRenderer";
import type { ConnectionStatus, FlowSignal, Market, ScannerSettings, TradeEvent } from "../types";

type ResonatorMode = ResonatorAudioParams["mode"];
type OutputMode = ResonatorAudioParams["output"];

const MAX_PRINT_SIZE = 5_000_000;
const usd = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;

// Feed-shaping options, mirrored from the Tape page so every page drives the
// same Hyperliquid stream the same way.
const MIN_SIZE_OPTIONS = [0, 1_000, 10_000, 50_000, 100_000];
const WINDOW_OPTIONS = [250, 500, 1_000];
const PRICE_BUCKET_OPTIONS = [0, 1, 2, 5];

// Resonator faders — these map straight onto the same AudioEngine the main
// Liquidated visualizer uses, so the standalone synth sounds identical.
const VOICE_FADERS: FaderSpec<keyof ResonatorAudioParams>[] = [
  { key: "maxVoices", label: "Max voices", min: 2, max: 24, step: 1, format: (v) => `${Math.round(v)}` },
  { key: "baseFrequency", label: "Frequency", min: 0, max: 60, step: 1, format: (v) => `${Math.round(v)} st` },
  { key: "structure", label: "Structure", min: 0, max: 0.999, step: 0.001, format: (v) => v.toFixed(3) },
  { key: "brightness", label: "Brightness", min: 0.1, max: 0.95, step: 0.01, format: (v) => v.toFixed(2) },
];

const RESONATOR_FADERS: FaderSpec<keyof ResonatorAudioParams>[] = [
  { key: "baseDamping", label: "Damping", min: 0, max: 0.98, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "basePosition", label: "Position", min: 0.02, max: 0.98, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "dampingLift", label: "Damp lift", min: 0, max: 0.35, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "positionSpread", label: "Pos spread", min: 0.05, max: 0.48, step: 0.01, format: (v) => v.toFixed(2) },
];

const ENV_FADERS: FaderSpec<keyof ResonatorAudioParams>[] = [
  { key: "attack", label: "Attack", min: 0.001, max: 0.5, step: 0.001, format: (v) => `${Math.round(v * 1000)}ms` },
  { key: "decay", label: "Decay", min: 0.02, max: 2.4, step: 0.01, format: (v) => `${v.toFixed(2)}s` },
  { key: "sustain", label: "Sustain", min: 0.01, max: 1, step: 0.01, format: (v) => v.toFixed(2) },
  { key: "release", label: "Release", min: 0.1, max: 4, step: 0.05, format: (v) => `${v.toFixed(2)}s` },
];

interface FeedStats {
  raw: number;
  accepted: number;
  lastSize: number;
}

export function SynthApp() {
  const audioRef = useRef<AudioEngine | null>(null);
  const driverRef = useRef<MarketDriver | null>(null);
  const visualCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<LiquidRenderer | null>(null);
  const masterMeterRef = useRef<HTMLDivElement | null>(null);
  const feedStatsRef = useRef<FeedStats>({ raw: 0, accepted: 0, lastSize: 0 });

  const [params, setParams] = useState<ResonatorAudioParams>({ ...DEFAULT_RESONATOR_AUDIO });
  const [market, setMarket] = useState<Market>("BTC");
  const [minOrderSize, setMinOrderSize] = useState(0);
  const [shaping, setShaping] = useState<FeedShaping>("aggregated");
  const [windowMs, setWindowMs] = useState(250);
  const [priceBucket, setPriceBucket] = useState(1);
  const [feedMode, setFeedMode] = useState<FeedMode>("off");
  const [feedStatus, setFeedStatus] = useState<ConnectionStatus | "off">("off");
  const [feedStats, setFeedStats] = useState<FeedStats>({ raw: 0, accepted: 0, lastSize: 0 });
  const [status, setStatus] = useState("Connect a market feed to drive the resonator");

  // The driver captures its callbacks once at mount, so mirror the live values
  // they read through refs.
  const settingsRef = useRef<ScannerSettings>(buildSettings(market, minOrderSize, windowMs));
  const visualSettingsRef = useRef({
    market: "BTC" as Market,
    mode: "live" as const,
    minPrintSize: 0,
    sensitivity: 1.15,
    clusterWindowMs: 1_000,
    volume: 0.4,
    timbre: 0.5,
    space: 0.45,
    cascadeIntensity: 1,
    viscosity: 0.72,
    turbulence: 0.62,
  });

  useEffect(() => {
    const audio = new AudioEngine();
    audio.setSettings(settingsRef.current);
    audio.setResonatorParams(params);
    audioRef.current = audio;

    if (visualCanvasRef.current) {
      const renderer = new LiquidRenderer(visualCanvasRef.current);
      rendererRef.current = renderer;
      renderer.render(visualSettingsRef.current);
    }

    const driver = new MarketDriver(market, {
      onTrade: (trade) => {
        audioRef.current?.playTrade(trade);
        rendererRef.current?.pushTrade(trade, visualSettingsRef.current);
      },
      onSignal: (signal: FlowSignal) => audioRef.current?.playSignal(signal),
      onStatus: (s) => setFeedStatus(s),
      onRawTrade: (trade) => {
        feedStatsRef.current.raw += 1;
        feedStatsRef.current.lastSize = trade.size;
        audioRef.current?.playTrade(trade, { micro: true });
      },
      onAcceptedTrade: () => {
        feedStatsRef.current.accepted += 1;
      },
    });
    driver.setMinOrderSize(minOrderSize);
    driver.setShaping(shaping);
    driver.setWindow(windowMs);
    driver.setPriceBucket(priceBucket);
    driverRef.current = driver;

    const statsTimer = window.setInterval(() => {
      const next = feedStatsRef.current;
      setFeedStats((prev) =>
        prev.raw === next.raw && prev.accepted === next.accepted && prev.lastSize === next.lastSize ? prev : { ...next },
      );
    }, 250);

    let frame = 0;
    const tick = () => {
      if (masterMeterRef.current) {
        masterMeterRef.current.style.transform = `scaleX(${(audioRef.current?.getLevel() ?? 0).toFixed(3)})`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(statsTimer);
      driver.dispose();
      audio.reset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep the resonator engine + feed settings in sync with the UI.
  useEffect(() => {
    audioRef.current?.setResonatorParams(params);
  }, [params]);

  useEffect(() => {
    settingsRef.current = buildSettings(market, minOrderSize, windowMs);
    audioRef.current?.setSettings(settingsRef.current);
    Object.assign(visualSettingsRef.current, {
      market,
      minPrintSize: minOrderSize,
      clusterWindowMs: windowMs,
    });
  }, [market, minOrderSize, windowMs]);

  const updateParam = (key: keyof ResonatorAudioParams, value: number) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  const updateSelect = <K extends "mode" | "output">(key: K, value: ResonatorAudioParams[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  const setMode = async (mode: FeedMode) => {
    setFeedMode(mode);
    feedStatsRef.current = { raw: 0, accepted: 0, lastSize: 0 };
    setFeedStats({ raw: 0, accepted: 0, lastSize: 0 });
    driverRef.current?.setMode(mode);
    await audioRef.current?.setEnabled(settingsRef.current, mode !== "off");
    if (mode === "off") {
      setFeedStatus("off");
      setStatus("Feed disconnected");
    } else {
      setStatus(`Feed → ${mode}; resonator armed`);
    }
  };

  const changeMarket = (next: Market) => {
    setMarket(next);
    feedStatsRef.current = { raw: 0, accepted: 0, lastSize: 0 };
    setFeedStats({ raw: 0, accepted: 0, lastSize: 0 });
    driverRef.current?.setMarket(next);
    driverRef.current?.setMinOrderSize(minOrderSize);
  };

  const updateMinOrderSize = (value: number) => {
    setMinOrderSize(value);
    driverRef.current?.setMinOrderSize(value);
    setStatus(`Min size → ${value === 0 ? "all trades" : `${usd(value)}+`}`);
  };

  const updateShaping = (value: FeedShaping) => {
    setShaping(value);
    driverRef.current?.setShaping(value);
    setStatus(value === "raw" ? "Shaping → raw (every fill triggers)" : "Shaping → aggregated");
  };

  const updateWindow = (value: number) => {
    setWindowMs(value);
    driverRef.current?.setWindow(value);
    setStatus(`Aggregation window → ${value}ms`);
  };

  const updatePriceBucket = (value: number) => {
    setPriceBucket(value);
    driverRef.current?.setPriceBucket(value);
    setStatus(value === 0 ? "Price bucket → exact" : `Price bucket → $${value}`);
  };

  const reset = () => {
    setParams({ ...DEFAULT_RESONATOR_AUDIO });
    setStatus("Resonator reset to defaults");
  };

  const renderFaders = (title: string, specs: FaderSpec<keyof ResonatorAudioParams>[]) => (
    <fieldset className="fader-group">
      <legend>{title}</legend>
      <div className="fader-row">
        {specs.map((spec) => (
          <Fader
            key={spec.key}
            spec={spec}
            value={params[spec.key] as number}
            onChange={(value) => updateParam(spec.key, value)}
          />
        ))}
      </div>
    </fieldset>
  );

  return (
    <div className="grain-lab">
      <header className="lab-head">
        <img className="brand-logo" src="/assets/liquidated_logo.svg" alt="Liquidated" />
        <nav className="lab-links">
          <a className="back-link" href="/index.html">← Visualizer</a>
          <a className="back-link" href="/tape.html">Tape →</a>
        </nav>
      </header>

      <p className="kicker">Resonator synth · Original Rings WASM</p>

      <div className="synth-visual" aria-label="Feed-driven buy and sell resonance">
        <canvas ref={visualCanvasRef}></canvas>
      </div>

      <section className="feed-bar">
        <span className="feed-label">Market Feed</span>
        <select value={market} onChange={(e) => changeMarket(e.target.value as Market)} aria-label="Market">
          {MARKETS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <div className="feed-modes" role="group" aria-label="Shaping">
          {(["raw", "aggregated"] as FeedShaping[]).map((value) => (
            <button
              key={value}
              type="button"
              className={`ghost-btn ${shaping === value ? "active" : ""}`}
              onClick={() => updateShaping(value)}
            >
              {value === "raw" ? "Raw" : "Aggregated"}
            </button>
          ))}
        </div>
        <label className="feed-select">
          <span>Min size</span>
          <select value={minOrderSize} onChange={(event) => updateMinOrderSize(Number(event.target.value))}>
            {MIN_SIZE_OPTIONS.map((value) => (
              <option key={value} value={value}>{value === 0 ? "0" : `${usd(value)}+`}</option>
            ))}
          </select>
        </label>
        <label className={`feed-select ${shaping === "raw" ? "disabled" : ""}`}>
          <span>Window</span>
          <select value={windowMs} disabled={shaping === "raw"} onChange={(event) => updateWindow(Number(event.target.value))}>
            {WINDOW_OPTIONS.map((value) => (
              <option key={value} value={value}>{value}ms</option>
            ))}
          </select>
        </label>
        <label className={`feed-select ${shaping === "raw" ? "disabled" : ""}`}>
          <span>Price bucket</span>
          <select value={priceBucket} disabled={shaping === "raw"} onChange={(event) => updatePriceBucket(Number(event.target.value))}>
            {PRICE_BUCKET_OPTIONS.map((value) => (
              <option key={value} value={value}>{value === 0 ? "exact" : `$${value}`}</option>
            ))}
          </select>
        </label>
        <div className="feed-modes">
          {(["off", "demo", "live"] as FeedMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={`ghost-btn ${feedMode === mode ? "active" : ""}`}
              onClick={() => setMode(mode)}
            >
              {mode === "off" ? "Off" : mode === "demo" ? "Demo" : "Live"}
            </button>
          ))}
        </div>
        <span className={`feed-status ${feedStatus === "live" || feedStatus === "demo" ? "on" : ""}`}>
          {feedStatus === "off" ? "disconnected" : feedStatus}
        </span>
        <span className="feed-stats">
          raw {feedStats.raw} · pass {feedStats.accepted} · last {usd(feedStats.lastSize)}
        </span>
      </section>

      <section className="transport-bar">
        <label className="select-field">
          <span>Model</span>
          <select value={params.mode} onChange={(event) => updateSelect("mode", event.target.value as ResonatorMode)}>
            <option value="modal">Modal resonator</option>
            <option value="sympathetic">Sympathetic strings</option>
            <option value="string">Modulated string</option>
          </select>
        </label>
        <label className="select-field">
          <span>Output</span>
          <select value={params.output} onChange={(event) => updateSelect("output", event.target.value as OutputMode)}>
            <option value="mix">Odd + Even</option>
            <option value="odd">Odd only</option>
            <option value="even">Even only</option>
          </select>
        </label>
        <div className="sample-name">Buys ring the Odd core · sells the Even resonance</div>
        <div className="level-meter"><div ref={masterMeterRef} className="level-fill" /></div>
      </section>

      <div className="fader-board">
        {renderFaders("Voices / pitch", VOICE_FADERS)}
        {renderFaders("Resonator", RESONATOR_FADERS)}
        {renderFaders("ADSR envelope", ENV_FADERS)}
      </div>

      <p className="lab-status">{status}</p>

      <section className="preset-bar">
        <button className="ghost-btn" type="button" onClick={reset}>Reset</button>
      </section>
    </div>
  );
}

function buildSettings(market: Market, minPrintSize: number, clusterWindowMs: number): ScannerSettings {
  return {
    market,
    mode: "live",
    minPrintSize,
    maxPrintSize: MAX_PRINT_SIZE,
    sensitivity: 1.15,
    clusterWindowMs,
    volume: 0.4,
    timbre: 0.5,
    space: 0.45,
    cascadeIntensity: 1,
    viscosity: 0.985,
    turbulence: 0.62,
  };
}
