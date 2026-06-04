import { useEffect, useRef, useState } from "react";
import * as Tone from "tone";
import { Fader, type FaderGroup } from "./Fader";
import {
  BIGSKY_GROUPS,
  DECO_GROUPS,
  DROPLET_GROUPS,
  ELCAP_GROUPS,
  FLOW_GROUPS,
  KLON_GROUPS,
  MASTER_GROUPS,
} from "./params";
import { DropletTrack, TRACK_DEFAULTS, type TrackId, type TrackParams } from "./dropletTrack";
import { DEFAULT_FLOW, FlowVoice, type FlowParams } from "./flowVoice";
import { DEFAULT_MASTER, MasterBus, type MasterParams } from "./masterBus";
import { MarketDriver, type FeedMode, type FeedShaping } from "./marketDriver";
import { DEFAULT_SHARED_FX, SharedFxRack, type SharedFxParams } from "./sharedFxRack";
import { ORDER_SIZE_TIERS, shapeTrade, TUNE_REF } from "./tradeMapping";
import { MARKET_CONFIG, MARKETS } from "../config/markets";
import { clamp } from "../utils/format";
import { LiquidRenderer } from "../visual/liquidRenderer";
import type { ConnectionStatus, FlowSignal, Market, Side, TradeEvent } from "../types";

const TRACK_IDS: TrackId[] = ["main"];

const TRACK_META: Record<TrackId, { title: string; role: string }> = {
  main: { title: "Droplets", role: "Buys high · Sells low" },
};

const SIGNAL_TRIGGER_GAP_MS = 260;
const usd = (value: number) => `$${Math.round(value).toLocaleString("en-US")}`;

// Feed-shaping options, mirrored from the Tape page so both pages drive the
// same Hyperliquid stream the same way.
const MIN_SIZE_OPTIONS = [0, 1_000, 10_000, 50_000, 100_000];
const WINDOW_OPTIONS = [250, 500, 1_000];
const PRICE_BUCKET_OPTIONS = [0, 1, 2, 5];

const cloneTracks = (): Record<TrackId, TrackParams> => ({
  main: structuredClone(TRACK_DEFAULTS.main),
});

const isDataMode = (mode: FeedMode) => mode !== "off";
const TRACK_DROPLET_GROUPS = DROPLET_GROUPS.map((group) => ({
  ...group,
  faders: group.faders.filter((spec) => spec.key !== "space" && spec.key !== "echo"),
})).filter((group) => group.faders.length > 0);

interface FeedStats {
  raw: number;
  accepted: number;
  lastSize: number;
}

export function SynthApp() {
  const masterRef = useRef<MasterBus | null>(null);
  const tracksRef = useRef<Record<TrackId, DropletTrack> | null>(null);
  const flowRef = useRef<FlowVoice | null>(null);
  const sharedFxRef = useRef<SharedFxRack | null>(null);
  const driverRef = useRef<MarketDriver | null>(null);
  const visualCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<LiquidRenderer | null>(null);
  const lastSignalTriggerRef = useRef<Record<Side, number>>({ buy: 0, sell: 0 });
  const feedStatsRef = useRef<FeedStats>({ raw: 0, accepted: 0, lastSize: 0 });
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

  const trackMeterRefs = {
    main: useRef<HTMLDivElement | null>(null),
  };
  const flowMeterRef = useRef<HTMLDivElement | null>(null);
  const masterMeterRef = useRef<HTMLDivElement | null>(null);

  const [tracks, setTracks] = useState<Record<TrackId, TrackParams>>(cloneTracks);
  const [sharedFx, setSharedFx] = useState<SharedFxParams>({ ...DEFAULT_SHARED_FX });
  const [flow, setFlow] = useState<FlowParams>({ ...DEFAULT_FLOW });
  const [master, setMaster] = useState<MasterParams>({ ...DEFAULT_MASTER });
  const [trackPlaying, setTrackPlaying] = useState<Record<TrackId, boolean>>({ main: false });
  const [flowPlaying, setFlowPlaying] = useState(false);

  const [market, setMarket] = useState<Market>("BTC");
  const [minOrderSize, setMinOrderSize] = useState(0);
  const [shaping, setShaping] = useState<FeedShaping>("aggregated");
  const [windowMs, setWindowMs] = useState(250);
  const [priceBucket, setPriceBucket] = useState(1);
  const [feedMode, setFeedMode] = useState<FeedMode>("off");
  const [feedStatus, setFeedStatus] = useState<ConnectionStatus | "off">("off");
  const [feedStats, setFeedStats] = useState<FeedStats>({ raw: 0, accepted: 0, lastSize: 0 });
  const [status, setStatus] = useState("Press a track to audition, or connect a market feed to drive them");

  // The driver captures handleFeedTrade once at mount, so mirror live values it reads.
  const tracksStateRef = useRef(tracks);
  tracksStateRef.current = tracks;
  const minOrderSizeRef = useRef(minOrderSize);
  minOrderSizeRef.current = minOrderSize;

  useEffect(() => {
    const masterBus = new MasterBus();
    const fxRack = new SharedFxRack(masterBus.input, DEFAULT_SHARED_FX);
    const builtTracks: Record<TrackId, DropletTrack> = {
      main: new DropletTrack(fxRack.input, TRACK_DEFAULTS.main),
    };
    const flowVoice = new FlowVoice(fxRack.input);
    masterRef.current = masterBus;
    tracksRef.current = builtTracks;
    flowRef.current = flowVoice;
    sharedFxRef.current = fxRack;
    if (visualCanvasRef.current) {
      const renderer = new LiquidRenderer(visualCanvasRef.current);
      rendererRef.current = renderer;
      renderer.render(visualSettingsRef.current);
    }

    const driver = new MarketDriver(market, {
      onTrade: handleFeedTrade,
      onSignal: handleFeedSignal,
      onStatus: (s) => setFeedStatus(s),
      onRawTrade: (trade) => {
        feedStatsRef.current.raw += 1;
        feedStatsRef.current.lastSize = trade.size;
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

    let frame = 0;
    const statsTimer = window.setInterval(() => {
      const next = feedStatsRef.current;
      setFeedStats((prev) =>
        prev.raw === next.raw && prev.accepted === next.accepted && prev.lastSize === next.lastSize ? prev : { ...next },
      );
    }, 250);

    const tick = () => {
      for (const id of TRACK_IDS) {
        const el = trackMeterRefs[id].current;
        if (el) el.style.transform = `scaleX(${builtTracks[id].getLevel().toFixed(3)})`;
      }
      if (flowMeterRef.current) flowMeterRef.current.style.transform = `scaleX(${flowVoice.getLevel().toFixed(3)})`;
      if (masterMeterRef.current) masterMeterRef.current.style.transform = `scaleX(${masterBus.getLevel().toFixed(3)})`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(statsTimer);
      driver.dispose();
      for (const id of TRACK_IDS) builtTracks[id].dispose();
      flowVoice.dispose();
      fxRack.dispose();
      masterBus.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    Object.assign(visualSettingsRef.current, {
      market,
      minPrintSize: minOrderSize,
      clusterWindowMs: windowMs,
    });
  }, [market, minOrderSize, windowMs]);

  // ── Feed → tracks mapping ────────────────────────────────────────────────
  // buys drive the High track, sells the Low track, liquidation/cascade the Mid
  // track. Large prints and clusters swell the matching track's FX.
  const handleFeedTrade = (trade: TradeEvent) => {
    const t = tracksRef.current;
    if (!t) return;
    const side = trade.side;

    const droplet = tracksStateRef.current.main.droplet;
    // Buy = upper register, sell = lower; size shapes pitch + ring within the
    // band. Pitch fader retunes everything. Shared with the visualizer engine.
    const shaped = shapeTrade(trade, {
      baseDecay: droplet.decay,
      tune: droplet.pitch / TUNE_REF,
      floor: minOrderSizeRef.current,
    });

    t.main.triggerDrop(undefined, { freq: shaped.freq, amp: shaped.amp, decay: shaped.decay });
    rendererRef.current?.pushTrade(trade, visualSettingsRef.current);
    if (shaped.pulse > 0) sharedFxRef.current?.pulse(shaped.pulse);
    if (shaped.second) {
      t.main.triggerDrop(Tone.now() + 0.12, shaped.second);
      setStatus(`${side === "buy" ? "Buy" : "Sell"} ${shaped.tier.id} ${usd(trade.size)} → ${Math.round(shaped.freq)} Hz`);
    }
  };

  const handleFeedSignal = (signal: FlowSignal) => {
    const boost = clamp(signal.intensity * 0.65, 0.25, 1.8);
    const side: Side = signal.side === "sell" ? "sell" : "buy";
    if (signal.timestamp - lastSignalTriggerRef.current[side] < SIGNAL_TRIGGER_GAP_MS) return;
    lastSignalTriggerRef.current[side] = signal.timestamp;

    sharedFxRef.current?.pulse(boost);
    setStatus(`${signal.label} → swell (${boost.toFixed(1)}×)`);
  };

  // ── Param updates ──────────────────────────────────────────────────────────
  const applySection = (
    track: DropletTrack,
    section: keyof TrackParams,
    params: TrackParams[keyof TrackParams],
    mode = feedMode,
  ) => {
    if (section === "droplet") {
      const droplet = params as TrackParams["droplet"];
      track.setDroplet(isDataMode(mode) ? { ...droplet, density: 0 } : droplet);
    }
  };

  const updateParam = <S extends keyof TrackParams>(id: TrackId, section: S, key: string, value: number) => {
    setTracks((prev) => {
      const sectionParams = { ...prev[id][section], [key]: value } as TrackParams[S];
      applySection(tracksRef.current![id], section, sectionParams);
      return { ...prev, [id]: { ...prev[id], [section]: sectionParams } };
    });
  };

  const updateFlow = (key: keyof FlowParams, value: number) => {
    setFlow((prev) => {
      const next = { ...prev, [key]: value };
      flowRef.current?.applyParams(next);
      return next;
    });
  };

  const updateMaster = (key: keyof MasterParams, value: number) => {
    setMaster((prev) => {
      const next = { ...prev, [key]: value };
      masterRef.current?.applyParams(next);
      return next;
    });
  };

  const updateSharedFx = <S extends keyof SharedFxParams>(section: S, key: string, value: number) => {
    setSharedFx((prev) => {
      const sectionParams = { ...prev[section], [key]: value } as SharedFxParams[S];
      const next = { ...prev, [section]: sectionParams };
      if (section === "klon") sharedFxRef.current?.setKlon(sectionParams as SharedFxParams["klon"]);
      else if (section === "deco") sharedFxRef.current?.setDeco(sectionParams as SharedFxParams["deco"]);
      else if (section === "elcap") sharedFxRef.current?.setEcho(sectionParams as SharedFxParams["elcap"]);
      else sharedFxRef.current?.setBigSky(sectionParams as SharedFxParams["bigSky"]);
      return next;
    });
  };

  // ── Transport ────────────────────────────────────────────────────────────
  const toggleTrack = async (id: TrackId) => {
    const track = tracksRef.current?.[id];
    if (!track) return;
    const playing = await track.toggle();
    setTrackPlaying((prev) => ({ ...prev, [id]: playing }));
    setStatus(playing ? `${TRACK_META[id].title} track running` : `${TRACK_META[id].title} track stopped`);
  };

  const toggleFlow = async () => {
    const voice = flowRef.current;
    if (!voice) return;
    const playing = await voice.toggle();
    setFlowPlaying(playing);
    setStatus(playing ? "Flow running" : "Flow stopped");
  };

  const setMode = async (mode: FeedMode) => {
    if (mode !== "off") {
      await Tone.start();
      const context = Tone.getContext();
      if (context.state !== "running") await context.resume();
    }
    setFeedMode(mode);
    feedStatsRef.current = { raw: 0, accepted: 0, lastSize: 0 };
    setFeedStats({ raw: 0, accepted: 0, lastSize: 0 });
    driverRef.current?.setMode(mode);
    for (const id of TRACK_IDS) {
      const track = tracksRef.current?.[id];
      if (track) applySection(track, "droplet", tracks[id].droplet, mode);
    }
    if (mode === "off") {
      for (const id of TRACK_IDS) tracksRef.current?.[id].stop();
      setTrackPlaying({ main: false });
      setFeedStatus("off");
    } else {
      await Promise.all(TRACK_IDS.map((id) => tracksRef.current?.[id].start()));
      setTrackPlaying({ main: true });
    }
    setStatus(mode === "off" ? "Feed disconnected" : `Feed → ${mode}; tracks armed, density disabled`);
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
    const fresh = cloneTracks();
    setTracks(fresh);
    for (const id of TRACK_IDS) tracksRef.current?.[id].applyAll(fresh[id]);
    setSharedFx({ ...DEFAULT_SHARED_FX });
    sharedFxRef.current?.applyAll({ ...DEFAULT_SHARED_FX });
    setMaster({ ...DEFAULT_MASTER });
    masterRef.current?.applyParams({ ...DEFAULT_MASTER });
    setFlow({ ...DEFAULT_FLOW });
    flowRef.current?.applyParams({ ...DEFAULT_FLOW });
    setStatus("Reset to defaults");
  };

  const renderGroups = <S extends keyof TrackParams>(
    groups: FaderGroup<string>[],
    id: TrackId,
    section: S,
    params: TrackParams[S],
  ) =>
    groups.map((group) => (
      <fieldset className="fader-group" key={group.title}>
        <legend>{group.title}</legend>
        <div className="fader-row">
          {group.faders.map((spec) => (
              <Fader
                key={spec.key}
                spec={spec}
                value={
                  isDataMode(feedMode) && section === "droplet" && spec.key === "density"
                    ? 0
                    : (params as unknown as Record<string, number>)[spec.key]
                }
                onChange={(v) => updateParam(id, section, spec.key, v)}
                disabled={isDataMode(feedMode) && section === "droplet" && spec.key === "density"}
              />
          ))}
        </div>
      </fieldset>
    ));

  const renderFxGroups = <S extends keyof SharedFxParams>(
    groups: FaderGroup<string>[],
    section: S,
    params: SharedFxParams[S],
  ) =>
    groups.map((group) => (
      <fieldset className="fader-group" key={group.title}>
        <legend>{group.title}</legend>
        <div className="fader-row">
          {group.faders.map((spec) => (
            <Fader
              key={spec.key}
              spec={spec}
              value={(params as unknown as Record<string, number>)[spec.key]}
              onChange={(v) => updateSharedFx(section, spec.key, v)}
            />
          ))}
        </div>
      </fieldset>
    ));

  return (
    <div className="grain-lab">
      <header className="lab-head">
        <div>
          <p className="kicker">Liquidated · Tone.js</p>
          <h1>Water Synth</h1>
        </div>
        <a className="back-link" href="/index.html">← Visualizer</a>
      </header>

      <div className="synth-visual" aria-label="Tape-driven buy and sell drops">
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

      {TRACK_IDS.map((id) => (
        <section className={`track track-${id}`} key={id}>
          <div className="transport-bar">
            <button
              className={`play-btn ${trackPlaying[id] ? "on" : ""}`}
              type="button"
              onClick={() => toggleTrack(id)}
            >
              {trackPlaying[id] ? `■ ${TRACK_META[id].title}` : `▶ ${TRACK_META[id].title}`}
            </button>
            <div className="sample-name">
              {TRACK_META[id].title} droplets — <strong>{TRACK_META[id].role}</strong> · own FX rack
            </div>
            <div className="level-meter"><div ref={trackMeterRefs[id]} className="level-fill" /></div>
          </div>

          <div className="fader-board">
            {renderGroups(TRACK_DROPLET_GROUPS, id, "droplet", tracks[id].droplet)}
          </div>
        </section>
      ))}

      <section className="transport-bar ambient-bar">
        <div className="sample-name">End FX — shared Klon · Deco · El Cap · Big Sky</div>
      </section>

      <div className="fader-board">
        {renderFxGroups(KLON_GROUPS, "klon", sharedFx.klon)}
        {renderFxGroups(DECO_GROUPS, "deco", sharedFx.deco)}
        {renderFxGroups(ELCAP_GROUPS, "elcap", sharedFx.elcap)}
        {renderFxGroups(BIGSKY_GROUPS, "bigSky", sharedFx.bigSky)}
      </div>

      <section className="transport-bar ambient-bar">
        <button className={`play-btn ${flowPlaying ? "on" : ""}`} type="button" onClick={toggleFlow}>
          {flowPlaying ? "■ Flow" : "▶ Flow"}
        </button>
        <div className="sample-name">Flow — turbulence bed + bubbling (shared space reverb)</div>
        <div className="level-meter"><div ref={flowMeterRef} className="level-fill" /></div>
      </section>

      <div className="fader-board">
        {FLOW_GROUPS.map((group) => (
          <fieldset className="fader-group ambient-group" key={group.title}>
            <legend>{group.title}</legend>
            <div className="fader-row">
              {group.faders.map((spec) => (
                <Fader key={spec.key} spec={spec} value={flow[spec.key]} onChange={(v) => updateFlow(spec.key, v)} />
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <section className="transport-bar ambient-bar">
        <div className="sample-name">Master — scale · tempo · output (shared by all tracks)</div>
        <div className="level-meter"><div ref={masterMeterRef} className="level-fill" /></div>
      </section>

      <div className="fader-board">
        {MASTER_GROUPS.map((group) => (
          <fieldset className="fader-group" key={group.title}>
            <legend>{group.title}</legend>
            <div className="fader-row">
              {group.faders.map((spec) => (
                <Fader key={spec.key} spec={spec} value={master[spec.key]} onChange={(v) => updateMaster(spec.key, v)} />
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <p className="lab-status">{status}</p>

      <section className="preset-bar">
        <button className="ghost-btn" type="button" onClick={reset}>Reset</button>
      </section>
    </div>
  );
}
