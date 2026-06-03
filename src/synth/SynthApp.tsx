import { useEffect, useRef, useState } from "react";
import { Fader } from "./Fader";
import { AMBIENT_GROUPS, FADER_GROUPS } from "./params";
import { DEFAULT_PARAMS, GrainSynth, type GrainParams } from "./grainSynth";
import { AmbientPad, DEFAULT_AMBIENT, type AmbientParams } from "./ambientPad";

const PRESET_KEY = "grainlab.presets";

interface Patch {
  grain: GrainParams;
  ambient: AmbientParams;
}

type PresetMap = Record<string, Patch>;

function normalizePatch(value: unknown): Patch {
  const raw = (value ?? {}) as Partial<Patch> & Partial<GrainParams>;
  // Back-compat: legacy presets stored a flat GrainParams object.
  const grain = (raw.grain ?? raw) as Partial<GrainParams>;
  return {
    grain: { ...DEFAULT_PARAMS, ...grain },
    ambient: { ...DEFAULT_AMBIENT, ...(raw.ambient ?? {}) },
  };
}

function loadPresets(): PresetMap {
  try {
    const raw = localStorage.getItem(PRESET_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: PresetMap = {};
    for (const [name, value] of Object.entries(parsed)) out[name] = normalizePatch(value);
    return out;
  } catch {
    return {};
  }
}

export function SynthApp() {
  const synthRef = useRef<GrainSynth | null>(null);
  const padRef = useRef<AmbientPad | null>(null);
  const meterRef = useRef<HTMLDivElement | null>(null);
  const padMeterRef = useRef<HTMLDivElement | null>(null);

  const [params, setParams] = useState<GrainParams>({ ...DEFAULT_PARAMS });
  const [ambient, setAmbient] = useState<AmbientParams>({ ...DEFAULT_AMBIENT });
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [padPlaying, setPadPlaying] = useState(false);
  const [sampleName, setSampleName] = useState("No sample");
  const [status, setStatus] = useState("Load a sample or use the demo tone");
  const [presets, setPresets] = useState<PresetMap>({});
  const [presetName, setPresetName] = useState("My Patch");
  const [selectedPreset, setSelectedPreset] = useState("");

  useEffect(() => {
    const synth = new GrainSynth();
    const pad = new AmbientPad();
    synthRef.current = synth;
    padRef.current = pad;
    setPresets(loadPresets());
    let frame = 0;
    const tick = () => {
      if (meterRef.current) meterRef.current.style.transform = `scaleX(${synth.getLevel().toFixed(3)})`;
      if (padMeterRef.current) padMeterRef.current.style.transform = `scaleX(${pad.getLevel().toFixed(3)})`;
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frame);
      synth.dispose();
      pad.dispose();
    };
  }, []);

  const update = (key: keyof GrainParams, value: number) => {
    setParams((prev) => {
      const next = { ...prev, [key]: value };
      const synth = synthRef.current;
      if (synth) {
        synth.applyParams(next);
        if (key === "reverse" || key === "position" || key === "spray") synth.restartIfPlaying();
      }
      return next;
    });
  };

  const updateAmbient = (key: keyof AmbientParams, value: number) => {
    setAmbient((prev) => {
      const next = { ...prev, [key]: value };
      padRef.current?.applyParams(next);
      return next;
    });
  };

  const applyAll = (patch: Patch) => {
    setParams(patch.grain);
    setAmbient(patch.ambient);
    synthRef.current?.applyParams(patch.grain);
    synthRef.current?.restartIfPlaying();
    padRef.current?.applyParams(patch.ambient);
  };

  const handleFile = async (file: File | undefined) => {
    const synth = synthRef.current;
    if (!file || !synth) return;
    setStatus(`Loading ${file.name}…`);
    try {
      await synth.loadFile(file);
      setLoaded(true);
      setSampleName(file.name);
      setStatus(`Loaded ${file.name} — press Play`);
    } catch (error) {
      setStatus(`Could not decode file: ${(error as Error).message}`);
    }
  };

  const handleDemo = () => {
    const synth = synthRef.current;
    if (!synth) return;
    synth.loadDemoBuffer();
    setLoaded(true);
    setSampleName("Demo tone");
    setStatus("Demo tone loaded — press Play");
  };

  const togglePlay = async () => {
    const synth = synthRef.current;
    if (!synth) return;
    if (!loaded) {
      setStatus("Load a sample or the demo tone first");
      return;
    }
    const isPlaying = await synth.toggle();
    setPlaying(isPlaying);
    setStatus(isPlaying ? "Playing" : "Stopped");
  };

  const togglePad = async () => {
    const pad = padRef.current;
    if (!pad) return;
    setPadPlaying(await pad.toggle());
  };

  const savePreset = () => {
    const name = presetName.trim() || "Untitled";
    const next = { ...presets, [name]: { grain: params, ambient } };
    localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    setPresets(next);
    setSelectedPreset(name);
    setStatus(`Saved preset “${name}”`);
  };

  const loadPreset = () => {
    const preset = presets[selectedPreset];
    if (!preset) return;
    applyAll(preset);
    setStatus(`Loaded preset “${selectedPreset}”`);
  };

  const deletePreset = () => {
    if (!selectedPreset) return;
    const next = { ...presets };
    delete next[selectedPreset];
    localStorage.setItem(PRESET_KEY, JSON.stringify(next));
    setPresets(next);
    setSelectedPreset("");
    setStatus("Preset deleted");
  };

  const reset = () => {
    applyAll({ grain: { ...DEFAULT_PARAMS }, ambient: { ...DEFAULT_AMBIENT } });
    setStatus("Reset to defaults");
  };

  return (
    <div className="grain-lab">
      <header className="lab-head">
        <div>
          <p className="kicker">Liquidated · Tone.js</p>
          <h1>Grain Lab</h1>
        </div>
        <a className="back-link" href="/index.html">← Visualizer</a>
      </header>

      <section className="transport-bar">
        <button className={`play-btn ${playing ? "on" : ""}`} type="button" onClick={togglePlay}>
          {playing ? "■ Stop" : "▶ Play"}
        </button>
        <label className="file-btn">
          <input type="file" accept="audio/*" onChange={(e) => handleFile(e.target.files?.[0])} />
          Load Sample
        </label>
        <button className="ghost-btn" type="button" onClick={handleDemo}>Demo Tone</button>
        <div className="sample-name" title={sampleName}>{sampleName}</div>
        <div className="level-meter"><div ref={meterRef} className="level-fill" /></div>
      </section>

      <p className="lab-status">{status}</p>

      <div className="fader-board">
        {FADER_GROUPS.map((group) => (
          <fieldset className="fader-group" key={group.title}>
            <legend>{group.title}</legend>
            <div className="fader-row">
              {group.faders.map((spec) => (
                <Fader key={spec.key} spec={spec} value={params[spec.key]} onChange={(v) => update(spec.key, v)} />
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <section className="transport-bar ambient-bar">
        <button className={`play-btn ${padPlaying ? "on" : ""}`} type="button" onClick={togglePad}>
          {padPlaying ? "■ Pad" : "▶ Pad"}
        </button>
        <div className="sample-name">Ambient drone — runs behind the grains</div>
        <div className="level-meter"><div ref={padMeterRef} className="level-fill" /></div>
      </section>

      <div className="fader-board">
        {AMBIENT_GROUPS.map((group) => (
          <fieldset className="fader-group ambient-group" key={group.title}>
            <legend>{group.title}</legend>
            <div className="fader-row">
              {group.faders.map((spec) => (
                <Fader
                  key={spec.key}
                  spec={spec}
                  value={ambient[spec.key]}
                  onChange={(v) => updateAmbient(spec.key, v)}
                />
              ))}
            </div>
          </fieldset>
        ))}
      </div>

      <section className="preset-bar">
        <input
          className="preset-name"
          value={presetName}
          onChange={(e) => setPresetName(e.target.value)}
          aria-label="Preset name"
        />
        <button className="ghost-btn" type="button" onClick={savePreset}>Save</button>
        <select value={selectedPreset} onChange={(e) => setSelectedPreset(e.target.value)} aria-label="Saved presets">
          <option value="">— presets —</option>
          {Object.keys(presets).sort().map((name) => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <button className="ghost-btn" type="button" onClick={loadPreset} disabled={!selectedPreset}>Load</button>
        <button className="ghost-btn" type="button" onClick={deletePreset} disabled={!selectedPreset}>Delete</button>
        <button className="ghost-btn" type="button" onClick={reset}>Reset</button>
      </section>
    </div>
  );
}
