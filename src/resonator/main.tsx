import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import * as Tone from "tone";
import { detectRingsDsp, RingsWasmVoice } from "./ringsDspClient";
import "./resonator.css";

type OutputMode = "odd" | "even" | "mix";
type ResonatorMode = "modal" | "sympathetic" | "string";
type Route = "odd" | "even";

interface ResonatorParams {
  frequency: number; // Rings-style semitone transpose, 0..60
  structure: number;
  brightness: number;
  damping: number;
  position: number;
  frequencyCv: number;
  structureCv: number;
  brightnessCv: number;
  dampingCv: number;
  positionCv: number;
  orderRate: number;
  orderSize: number;
  pitchRandom: number;
  bernoulli: number;
  attack: number;
  decay: number;
  sustain: number;
  release: number;
  output: OutputMode;
  mode: ResonatorMode;
}

const DEFAULTS: ResonatorParams = {
  frequency: 30,
  structure: 0.5,
  brightness: 0.55,
  damping: 0.55,
  position: 0.5,
  frequencyCv: 0,
  structureCv: 0,
  brightnessCv: 0,
  dampingCv: 0,
  positionCv: 0,
  orderRate: 1.1,
  orderSize: 0.55,
  pitchRandom: 0.6,
  bernoulli: 0.5,
  attack: 0.006,
  decay: 0.18,
  sustain: 0.24,
  release: 0.9,
  output: "mix",
  mode: "modal",
};

interface FaderSpec<K extends keyof ResonatorParams = keyof ResonatorParams> {
  key: K;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (value: number) => string;
}

const ORDER_FADERS: FaderSpec[] = [
  { key: "orderRate", label: "Gate rate", min: 0.1, max: 10, step: 0.1, unit: "Hz", format: (v) => `${v.toFixed(1)}Hz` },
  { key: "orderSize", label: "Order size", min: 0, max: 1, step: 0.01, format: (v) => `$${Math.round(Math.pow(10, 2.6 + v * 3.3)).toLocaleString("en-US")}` },
  { key: "pitchRandom", label: "Pitch rand", min: 0, max: 1, step: 0.01 },
  { key: "bernoulli", label: "Odd chance", min: 0, max: 1, step: 0.01, format: (v) => `${Math.round(v * 100)}%` },
];

const ADSR_FADERS: FaderSpec[] = [
  { key: "attack", label: "Attack", min: 0.001, max: 0.5, step: 0.001, format: (v) => `${Math.round(v * 1000)}ms` },
  { key: "decay", label: "Decay", min: 0.02, max: 1.8, step: 0.01, format: (v) => `${v.toFixed(2)}s` },
  { key: "sustain", label: "Sustain", min: 0.01, max: 1, step: 0.01 },
  { key: "release", label: "Release", min: 0.04, max: 5, step: 0.01, format: (v) => `${v.toFixed(2)}s` },
];

const RINGS_FADERS: FaderSpec[] = [
  { key: "frequency", label: "Frequency", min: 0, max: 60, step: 1, format: (v) => `${Math.round(v)} st` },
  { key: "structure", label: "Structure", min: 0, max: 0.9995, step: 0.001 },
  { key: "brightness", label: "Brightness", min: 0, max: 1, step: 0.01 },
  { key: "damping", label: "Damping", min: 0, max: 0.9995, step: 0.001 },
  { key: "position", label: "Position", min: 0, max: 0.9995, step: 0.001 },
];

const CV_FADERS: FaderSpec[] = [
  { key: "frequencyCv", label: "Freq CV", min: -1, max: 1, step: 0.01 },
  { key: "structureCv", label: "Struct CV", min: -1, max: 1, step: 0.01 },
  { key: "brightnessCv", label: "Bright CV", min: -1, max: 1, step: 0.01 },
  { key: "dampingCv", label: "Damp CV", min: -1, max: 1, step: 0.01 },
  { key: "positionCv", label: "Pos CV", min: -1, max: 1, step: 0.01 },
];

class BrowserRings {
  private odd = new Tone.Gain(0.72);
  private even = new Tone.Gain(0.72);
  private master = new Tone.Gain(0.85).toDestination();
  private meterOdd = new Tone.Meter({ smoothing: 0.82 });
  private meterEven = new Tone.Meter({ smoothing: 0.82 });
  private params = DEFAULTS;

  constructor() {
    this.odd.connect(this.master);
    this.even.connect(this.master);
    this.odd.connect(this.meterOdd);
    this.even.connect(this.meterEven);
  }

  apply(params: ResonatorParams) {
    this.params = params;
    this.odd.gain.rampTo(params.output === "even" ? 0 : params.output === "odd" ? 0.95 : 0.72, 0.02);
    this.even.gain.rampTo(params.output === "odd" ? 0 : params.output === "even" ? 0.95 : 0.72, 0.02);
  }

  trigger(route: Route, freq: number, velocity: number, cv: number) {
    const p = this.params;
    const target = route === "odd" ? this.odd : this.even;
    const patch = {
      structure: clamp(p.structure + p.structureCv * cv * 0.75, 0, 0.9995),
      brightness: clamp(p.brightness + p.brightnessCv * cv * 0.75, 0, 1),
      damping: clamp(p.damping + p.dampingCv * cv * 0.75, 0, 0.9995),
      position: clamp(p.position + p.positionCv * cv * 0.75, 0, 0.9995),
      frequencyOffset: p.frequencyCv * cv * 18,
    };
    const baseFreq = freq * Math.pow(2, patch.frequencyOffset / 12);
    const ratios = partialRatios(p.mode, patch.structure);
    const now = Tone.now();
    const baseDecay = 0.08 + patch.damping * 4.2;
    const brightnessCurve = 0.18 + patch.brightness * 1.45;

    ratios.forEach((ratio, index) => {
      const partial = index + 1;
      const isEven = partial % 2 === 0;
      const oddEvenBias = route === "even" ? (isEven ? 1 : 0.28) : isEven ? 0.28 : 1;
      const positionNull = isEven ? Math.abs(patch.position - 0.5) * 2 : 1 - Math.abs(patch.position - 0.08) * 0.2;
      const amp = velocity * oddEvenBias * Math.pow(partial, -brightnessCurve) * Math.max(0.04, positionNull);
      const partialFreq = baseFreq * ratio;
      if (partialFreq > 11000 || amp < 0.004) return;

      const osc = new Tone.Oscillator({
        frequency: partialFreq,
        type: p.mode === "string" ? "triangle" : "sine",
      });
      const filter = new Tone.Filter({
        type: "bandpass",
        frequency: partialFreq,
        Q: 4 + patch.damping * 34,
      });
      const gain = new Tone.Gain(0);
      osc.connect(filter).connect(gain).connect(target);

      const ringDecay = Math.max(0.04, baseDecay / Math.pow(partial, 0.08 + (1 - patch.brightness) * 0.32));
      const peak = Math.max(0.0002, amp * 0.32);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + p.attack);
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * p.sustain), now + p.attack + p.decay);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + p.attack + p.decay + Math.max(p.release, ringDecay));
      osc.start(now);
      osc.stop(now + p.attack + p.decay + Math.max(p.release, ringDecay) + 0.08);
      osc.onstop = () => {
        osc.dispose();
        filter.dispose();
        gain.dispose();
      };
    });
  }

  levels() {
    return {
      odd: meterTo01(this.meterOdd.getValue()),
      even: meterTo01(this.meterEven.getValue()),
    };
  }

  dispose() {
    this.odd.dispose();
    this.even.dispose();
    this.master.dispose();
    this.meterOdd.dispose();
    this.meterEven.dispose();
  }
}

function partialRatios(mode: ResonatorMode, structure: number) {
  const harmonic = Array.from({ length: 20 }, (_, i) => i + 1);
  if (mode === "modal") {
    const bend = (structure - 0.5) * 0.22;
    return harmonic.map((n) => n * (1 + bend * Math.log2(n)));
  }
  if (mode === "sympathetic") {
    const fifth = 1.5 + (structure - 0.5) * 0.16;
    return [1, fifth, 2, 2 * fifth, 3, 4, 4 * fifth, 5, 6, 8, 9, 10, 12, 15, 16, 18];
  }
  return harmonic.map((n) => n + Math.sin(n * 1.7) * structure * 0.24);
}

function orderToPitch(params: ResonatorParams) {
  const side = Math.random() > 0.5 ? "buy" : "sell";
  const randomSize = Math.pow(10, 2.6 + Math.random() * 3.3);
  const targetSize = Math.pow(10, 2.6 + params.orderSize * 3.3);
  const size = Math.round(randomSize * 0.55 + targetSize * 0.45);
  const cv = clamp((Math.log10(size) - 2.6) / 3.3, 0, 1);
  const sideBias = side === "buy" ? 5 : -5;
  const jitter = (Math.random() - 0.5) * params.pitchRandom * 28;
  const semis = params.frequency - 30 + (cv - 0.5) * params.pitchRandom * 32 + sideBias + jitter;
  return {
    side,
    size,
    cv,
    freq: 220 * Math.pow(2, semis / 12),
    velocity: clamp(0.16 + cv * 0.85, 0.12, 1),
  };
}

function meterTo01(value: number | number[]) {
  const db = Array.isArray(value) ? Math.max(...value) : value;
  if (!Number.isFinite(db)) return 0;
  return clamp((db + 54) / 54, 0, 1);
}

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function formatOrder(value: number) {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K`;
  return `$${value.toFixed(0)}`;
}

function App() {
  const [params, setParams] = useState(DEFAULTS);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("ready");
  const [engineStatus, setEngineStatus] = useState("checking DSP engine...");
  const [route, setRoute] = useState<Route>("odd");
  const [levels, setLevels] = useState({ odd: 0, even: 0 });
  const resonatorRef = useRef<BrowserRings | null>(null);
  const timerRef = useRef(0);
  const paramsRef = useRef(params);
  const wasmRef = useRef<RingsWasmVoice | null>(null);
  paramsRef.current = params;

  useEffect(() => {
    detectRingsDsp().then((result) => {
      if (!result.available) {
        setEngineStatus(result.reason);
        return;
      }
      const wasm = new RingsWasmVoice();
      wasmRef.current = wasm;
      wasm.init()
        .then(() => setEngineStatus("Original Rings WASM active"))
        .catch((error) => {
          wasmRef.current = null;
          setEngineStatus(`Rings WASM failed: ${error instanceof Error ? error.message : "unknown error"}`);
        });
    });
    const resonator = new BrowserRings();
    resonatorRef.current = resonator;
    let frame = 0;
    const tick = () => {
      setLevels(resonator.levels());
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      window.clearInterval(timerRef.current);
      wasmRef.current?.dispose();
      resonator.dispose();
    };
  }, []);

  useEffect(() => {
    resonatorRef.current?.apply(params);
    wasmRef.current?.setPatch(params);
  }, [params]);

  useEffect(() => {
    window.clearInterval(timerRef.current);
    if (!running) return;
    timerRef.current = window.setInterval(() => trigger(), Math.max(90, 1000 / params.orderRate));
    return () => window.clearInterval(timerRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running, params.orderRate]);

  const startAudio = async () => {
    await Tone.start();
    const context = Tone.getContext();
    if (context.state !== "running") await context.resume();
  };

  const trigger = async () => {
    const p = paramsRef.current;
    const nextRoute: Route = Math.random() < p.bernoulli ? "odd" : "even";
    const order = orderToPitch(p);
    const wasm = wasmRef.current;
    if (wasm) {
      await wasm.resume();
      wasm.setPatch(p);
      const nextLevels = wasm.strum({
        output: p.output,
        vOct: Math.log2(order.freq / 440),
        velocity: order.velocity,
        exciter: order.cv,
        duration: clamp(0.4 + p.release + p.damping * 2.2, 0.8, 4.5),
        attack: p.attack,
        decay: p.decay,
        sustain: p.sustain,
        release: p.release,
      });
      setLevels(nextLevels);
    } else {
      await startAudio();
      resonatorRef.current?.trigger(nextRoute, order.freq, order.velocity, order.cv);
    }
    setRoute(nextRoute);
    setStatus(`${order.side.toUpperCase()} ${formatOrder(order.size)} → ${Math.round(order.freq)}Hz → ${nextRoute.toUpperCase()}`);
  };

  const update = <K extends keyof ResonatorParams>(key: K, value: ResonatorParams[K]) => {
    setParams((prev) => ({ ...prev, [key]: value }));
  };

  const renderFaders = (title: string, specs: FaderSpec[]) => (
    <fieldset className="fader-group">
      <legend>{title}</legend>
      <div className="fader-row">
        {specs.map((spec) => (
          <Fader
            key={spec.key}
            spec={spec}
            value={params[spec.key] as number}
            onChange={(value) => update(spec.key, value as never)}
          />
        ))}
      </div>
    </fieldset>
  );

  return (
    <main className="resonator-lab">
      <header className="lab-head">
        <div>
          <p className="kicker">Liquidated · Resonator</p>
          <h1>HL Order Rings</h1>
        </div>
        <a className="back-link" href="/synth.html">Synth</a>
      </header>

      <section className="transport-bar">
        <button className="play-btn" type="button" onClick={trigger}>Strum</button>
        <button className={`play-btn ${running ? "on" : ""}`} type="button" onClick={() => setRunning((value) => !value)}>
          {running ? "Stop HL Random" : "Run HL Random"}
        </button>
        <label className="select-field">
          <span>Model</span>
          <select value={params.mode} onChange={(event) => update("mode", event.target.value as ResonatorMode)}>
            <option value="modal">Modal resonator</option>
            <option value="sympathetic">Sympathetic strings</option>
            <option value="string">Modulated string</option>
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
        <div className="output-meter">
          <span className={route === "odd" ? "hot" : ""}>Odd</span>
          <i style={{ transform: `scaleX(${levels.odd})` }} />
        </div>
        <div className="output-meter">
          <span className={route === "even" ? "hot" : ""}>Even</span>
          <i style={{ transform: `scaleX(${levels.even})` }} />
        </div>
      </section>

      <p className="lab-status">{status}</p>
      <p className="engine-status">{engineStatus}</p>

      <div className="fader-board">
        {renderFaders("Random order gate / pitch", ORDER_FADERS)}
        {renderFaders("ADSR envelope", ADSR_FADERS)}
        {renderFaders("Resonator", RINGS_FADERS)}
        {renderFaders("CV attenuverters", CV_FADERS)}
      </div>

      <section className="notes-panel">
        <strong>DSP status</strong>
        <span>
          If /rings/rings-dsp.js is present, Strum uses the original Rings DSP core compiled to WASM. Without that artifact,
          the page keeps running with the Tone modal fallback.
        </span>
      </section>
    </main>
  );
}

function Fader<K extends keyof ResonatorParams>({
  spec,
  value,
  onChange,
}: {
  spec: FaderSpec<K>;
  value: number;
  onChange: (value: number) => void;
}) {
  const text = spec.format ? spec.format(value) : `${value.toFixed(2)}${spec.unit ?? ""}`;
  return (
    <label className="fader">
      <output className="fader-value">{text}</output>
      <input
        className="fader-input"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="fader-label">{spec.label}</span>
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
