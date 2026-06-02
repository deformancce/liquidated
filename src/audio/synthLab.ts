import * as Tone from "tone";
import { GranularEngine } from "./granularEngine";

type LabControl = HTMLInputElement | HTMLSelectElement;
type StoredPresetMap = Record<string, SynthLabPreset>;

interface SynthLabPreset {
  fullChain: boolean;
  grainSize: number;
  overlap: number;
  playbackRate: number;
  detune: number;
  reverse: boolean;
  position: number;
  positionJitter: number;
  density: number;
  pitchRandom: number;
  ampRandom: number;
  pitch: number;
  pitchWindow: number;
  filterCutoff: number;
  filterQ: number;
  lfoRate: number;
  lfoDepth: number;
  delayTime: number;
  delayFeedback: number;
  delaySend: number;
  reverbDecay: number;
  reverbPreDelay: number;
  reverbSend: number;
  spatialX: number;
  spatialY: number;
  spatialZ: number;
  dryBus: number;
  master: number;
}

const DEFAULT_PRESET: SynthLabPreset = {
  fullChain: false,
  grainSize: 0.12,
  overlap: 0.06,
  playbackRate: 1,
  detune: 0,
  reverse: false,
  position: 0.5,
  positionJitter: 0.12,
  density: 18,
  pitchRandom: 0,
  ampRandom: 0.15,
  pitch: 0,
  pitchWindow: 0.08,
  filterCutoff: 1400,
  filterQ: 8,
  lfoRate: 0.35,
  lfoDepth: 500,
  delayTime: 0.25,
  delayFeedback: 0.38,
  delaySend: 0.18,
  reverbDecay: 4.5,
  reverbPreDelay: 0.08,
  reverbSend: 0.28,
  spatialX: 0,
  spatialY: 0,
  spatialZ: -0.5,
  dryBus: 0.74,
  master: 0.55,
};

const STORAGE_KEY = "liquidated.synthLab.presets";

export class SynthLab {
  private root: HTMLElement;
  private player: GranularEngine | null = null;
  private objectUrl: string | null = null;
  private playing = false;
  private restartTimer = 0;
  private fullChain = DEFAULT_PRESET.fullChain;
  private master = new Tone.Gain(DEFAULT_PRESET.master).toDestination();
  private dryBus = new Tone.Gain(DEFAULT_PRESET.dryBus).connect(this.master);
  private delayInput = new Tone.Gain(DEFAULT_PRESET.delaySend);
  private delayOutput = new Tone.Gain(1).connect(this.master);
  private reverbInput = new Tone.Gain(DEFAULT_PRESET.reverbSend);
  private reverbOutput = new Tone.Gain(1).connect(this.master);
  private pitchShift = new Tone.PitchShift({
    pitch: DEFAULT_PRESET.pitch,
    windowSize: DEFAULT_PRESET.pitchWindow,
    feedback: 0,
    wet: 1,
  });
  private lfoFilter = new Tone.Filter({
    type: "bandpass",
    frequency: DEFAULT_PRESET.filterCutoff,
    Q: DEFAULT_PRESET.filterQ,
    rolloff: -24,
  });
  private lfo = new Tone.LFO({
    frequency: DEFAULT_PRESET.lfoRate,
    min: DEFAULT_PRESET.filterCutoff - DEFAULT_PRESET.lfoDepth,
    max: DEFAULT_PRESET.filterCutoff + DEFAULT_PRESET.lfoDepth,
  }).start();
  private spatial = new Tone.Panner3D({
    positionX: DEFAULT_PRESET.spatialX,
    positionY: DEFAULT_PRESET.spatialY,
    positionZ: DEFAULT_PRESET.spatialZ,
    panningModel: "HRTF",
    distanceModel: "inverse",
    refDistance: 1,
    rolloffFactor: 0.6,
  });
  private delay = new Tone.PingPongDelay({
    delayTime: DEFAULT_PRESET.delayTime,
    feedback: DEFAULT_PRESET.delayFeedback,
    wet: 1,
  });
  private reverb = new Tone.Reverb({
    decay: DEFAULT_PRESET.reverbDecay,
    preDelay: DEFAULT_PRESET.reverbPreDelay,
    wet: 1,
  });

  constructor(root: HTMLElement) {
    this.root = root;
    this.lfo.connect(this.lfoFilter.frequency);
    this.bind();
    this.syncFromControls();
  }

  private bind(): void {
    this.decorateControls();
    this.button("synthLabToggle").addEventListener("click", () => {
      this.root.classList.toggle("collapsed");
    });
    this.input("sampleFile").addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) this.loadFile(file);
    });
    this.button("waterSeed").addEventListener("click", () => this.loadWaterSeed());
    this.button("grainPlay").addEventListener("click", () => this.play());
    this.button("grainAudition").addEventListener("click", () => this.audition());
    this.button("grainStop").addEventListener("click", () => this.stop());
    this.button("grainRestart").addEventListener("click", () => this.restart());
    this.button("copySynthPreset").addEventListener("click", () => this.copyPreset());
    this.button("saveSynthPreset").addEventListener("click", () => this.saveCurrentPreset());
    this.button("loadSynthPreset").addEventListener("click", () => this.loadSelectedPreset());
    this.button("deleteSynthPreset").addEventListener("click", () => this.deleteSelectedPreset());
    this.button("applySynthPreset").addEventListener("click", () => this.applyPresetJson());
    this.button("resetSynthPreset").addEventListener("click", () => this.applyPreset(DEFAULT_PRESET, "Default preset"));

    for (const control of this.root.querySelectorAll<LabControl>("input[data-synth], select[data-synth]")) {
      control.addEventListener("input", () => this.syncFromControls(control.id));
      control.addEventListener("change", () => this.syncFromControls(control.id));
    }
    this.refreshPresetSelect();
  }

  private async loadFile(file: File): Promise<void> {
    this.setStatus(`Loading ${file.name}`);
    this.stop();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.player?.dispose();
    const buffer = new Tone.ToneAudioBuffer(
      this.objectUrl,
      () => {
        this.player = new GranularEngine();
        this.player.load(buffer);
        this.connectPlayer();
        this.setStatus(file.name);
        this.syncFromControls();
      },
      (error) => this.setStatus(error.message)
    );
  }

  private connectPlayer(): void {
    if (!this.player) return;
    this.player.disconnect();
    this.lfoFilter.disconnect();
    this.delayInput.disconnect();
    this.delay.disconnect();
    this.delayOutput.disconnect();
    this.reverbInput.disconnect();
    this.reverb.disconnect();
    this.spatial.disconnect();
    this.reverbOutput.disconnect();
    if (this.fullChain) {
      this.player.chain(this.pitchShift, this.lfoFilter);
      this.lfoFilter.connect(this.dryBus);
      this.lfoFilter.connect(this.delayInput);
      this.delayInput.connect(this.delay);
      this.delay.connect(this.delayOutput);
      this.delayOutput.connect(this.master);
      this.delay.connect(this.reverbInput);
      this.reverbInput.chain(this.reverb, this.spatial, this.reverbOutput, this.master);
      this.setStatus("Full chain: Grain -> Pitch -> LFO Filter, Dry + Delay -> Reverb -> 3D");
    } else {
      this.player.connect(this.dryBus);
      this.setStatus("Granular only: GrainPlayer -> Output");
    }
  }

  private async play(): Promise<void> {
    if (!this.player) {
      this.setStatus("Load a sample first");
      return;
    }
    await Tone.start();
    if (!this.playing) {
      this.player.start();
      this.playing = true;
      this.setTransportState(true);
    }
  }

  private async audition(): Promise<void> {
    if (!this.player) {
      this.loadWaterSeed();
    }
    await Tone.start();
    this.player?.restart();
    this.playing = true;
    this.setTransportState(true);
    window.setTimeout(() => {
      this.stop();
      this.setStatus("Audition complete");
    }, 2200);
  }

  private stop(): void {
    this.player?.stop();
    this.playing = false;
    this.setTransportState(false);
  }

  private async restart(): Promise<void> {
    if (!this.player) return;
    await Tone.start();
    this.player.restart();
    this.playing = true;
    this.setTransportState(true);
  }

  private syncFromControls(changedId = ""): void {
    const preset = this.readPreset();
    const previousPlaying = this.playing;
    const chainChanged = preset.fullChain !== this.fullChain;
    this.fullChain = preset.fullChain;
    this.master.gain.rampTo(preset.master, 0.05);
    this.dryBus.gain.rampTo(preset.dryBus, 0.05);
    this.delayInput.gain.rampTo(preset.delaySend, 0.05);
    this.reverbInput.gain.rampTo(preset.reverbSend, 0.05);
    this.pitchShift.pitch = preset.pitch;
    this.pitchShift.windowSize = preset.pitchWindow;
    this.lfoFilter.frequency.rampTo(preset.filterCutoff, 0.05);
    this.lfoFilter.Q.rampTo(preset.filterQ, 0.05);
    this.lfo.frequency.rampTo(preset.lfoRate, 0.05);
    this.lfo.min = Math.max(20, preset.filterCutoff - preset.lfoDepth);
    this.lfo.max = preset.filterCutoff + preset.lfoDepth;
    this.delay.delayTime.rampTo(preset.delayTime, 0.05);
    this.delay.feedback.rampTo(preset.delayFeedback, 0.05);
    this.reverb.decay = preset.reverbDecay;
    this.reverb.preDelay = preset.reverbPreDelay;
    this.spatial.setPosition(preset.spatialX, preset.spatialY, preset.spatialZ);

    if (this.player) {
      this.player.setSettings({
        grainSize: preset.grainSize,
        overlap: preset.overlap,
        playbackRate: Math.max(0.05, preset.playbackRate),
        detune: preset.detune,
        reverse: preset.reverse,
        position: preset.position,
        positionJitter: preset.positionJitter,
        density: preset.density,
        pitchRandom: preset.pitchRandom,
        ampRandom: preset.ampRandom,
      });
    }

    if (chainChanged) {
      this.connectPlayer();
    }

    if (this.isGranularControl(changedId)) {
      this.scheduleAudibleRestart();
    }

    this.updateControlReadouts();
    if (changedId) {
      this.setStatus(`${this.controlLabel(changedId)} applied${previousPlaying ? "" : " (press Play to hear it)"}`);
    }
    this.writePreset(preset);
  }

  private decorateControls(): void {
    for (const control of this.root.querySelectorAll<HTMLInputElement>("input[data-synth]")) {
      const label = control.closest("label");
      if (!label || label.querySelector(".control-value")) continue;
      const output = document.createElement("output");
      output.className = "control-value";
      output.htmlFor = control.id;
      label.append(output);
    }
    this.updateControlReadouts();
  }

  private updateControlReadouts(): void {
    for (const control of this.root.querySelectorAll<HTMLInputElement>("input[data-synth]")) {
      const output = control.closest("label")?.querySelector<HTMLOutputElement>(".control-value");
      if (!output) continue;
      output.value = control.type === "checkbox" ? (control.checked ? "on" : "off") : this.formatValue(control.value);
    }
  }

  private formatValue(value: string): string {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return value;
    if (Math.abs(numeric) >= 100) return String(Math.round(numeric));
    if (Math.abs(numeric) >= 10) return numeric.toFixed(1);
    return numeric.toFixed(2);
  }

  private controlLabel(id: string): string {
    const label = this.root.querySelector(`#${id}`)?.closest("label")?.querySelector("span")?.textContent;
    return label || "Control";
  }

  private isGranularControl(id: string): boolean {
    return [
      "grainSize",
      "grainOverlap",
      "playbackRate",
      "grainDetune",
      "grainReverse",
      "grainPosition",
      "grainJitter",
      "grainDensity",
      "pitchRandom",
      "ampRandom",
      "fullChain",
    ].includes(id);
  }

  private scheduleAudibleRestart(): void {
    if (!this.player || !this.playing) return;
    window.clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => {
      this.player?.stop();
      this.player?.start();
      this.setStatus("Granular settings applied");
    }, 80);
  }

  private loadWaterSeed(): void {
    this.stop();
    if (this.objectUrl) {
      URL.revokeObjectURL(this.objectUrl);
      this.objectUrl = null;
    }
    this.player?.dispose();
    this.player = new GranularEngine();
    this.player.load(this.createWaterSeedBuffer());
    this.connectPlayer();
    this.syncFromControls();
    this.setStatus("Generated water seed loaded");
  }

  private createWaterSeedBuffer(): AudioBuffer {
    const sampleRate = Tone.getContext().sampleRate;
    const duration = 2.8;
    const buffer = Tone.getContext().createBuffer(1, Math.floor(sampleRate * duration), sampleRate);
    const data = buffer.getChannelData(0);
    const droplets = [
      { at: 0.08, frequency: 720, gain: 0.9, decay: 0.2 },
      { at: 0.42, frequency: 980, gain: 0.48, decay: 0.16 },
      { at: 0.86, frequency: 540, gain: 0.62, decay: 0.28 },
      { at: 1.38, frequency: 1240, gain: 0.36, decay: 0.14 },
      { at: 1.92, frequency: 680, gain: 0.52, decay: 0.22 },
      { at: 2.36, frequency: 420, gain: 0.38, decay: 0.34 },
    ];

    for (let index = 0; index < data.length; index += 1) {
      const time = index / sampleRate;
      let sample = 0;
      for (const droplet of droplets) {
        const local = time - droplet.at;
        if (local < 0) continue;
        const envelope = Math.exp(-local / droplet.decay);
        const sweep = droplet.frequency * (1 + Math.exp(-local / 0.08) * 0.42);
        sample += Math.sin(local * sweep * Math.PI * 2) * envelope * droplet.gain;
        sample += (Math.random() * 2 - 1) * Math.exp(-local / 0.035) * droplet.gain * 0.08;
      }
      data[index] = Math.max(-1, Math.min(1, sample * 0.42));
    }

    return buffer;
  }

  private readPreset(): SynthLabPreset {
    return {
      fullChain: this.input("fullChain").checked,
      grainSize: this.number("grainSize"),
      overlap: this.number("grainOverlap"),
      playbackRate: this.number("playbackRate"),
      detune: this.number("grainDetune"),
      reverse: this.input("grainReverse").checked,
      position: this.number("grainPosition"),
      positionJitter: this.number("grainJitter"),
      density: this.number("grainDensity"),
      pitchRandom: this.number("pitchRandom"),
      ampRandom: this.number("ampRandom"),
      pitch: this.number("pitchShift"),
      pitchWindow: this.number("pitchWindow"),
      filterCutoff: this.number("filterCutoff"),
      filterQ: this.number("filterQ"),
      lfoRate: this.number("lfoRate"),
      lfoDepth: this.number("lfoDepth"),
      delayTime: this.number("delayTime"),
      delayFeedback: this.number("delayFeedback"),
      delaySend: this.number("delaySend"),
      reverbDecay: this.number("reverbDecay"),
      reverbPreDelay: this.number("reverbPreDelay"),
      reverbSend: this.number("reverbSend"),
      spatialX: this.number("spatialX"),
      spatialY: this.number("spatialY"),
      spatialZ: this.number("spatialZ"),
      dryBus: this.number("dryBus"),
      master: this.number("labMaster"),
    };
  }

  private writePreset(preset: SynthLabPreset): void {
    this.textarea("synthPresetOutput").value = JSON.stringify(preset, null, 2);
  }

  private applyPreset(preset: SynthLabPreset, status = "Preset applied"): void {
    const clean = this.sanitizePreset(preset);
    this.setInputValue("grainSize", clean.grainSize);
    this.input("fullChain").checked = clean.fullChain;
    this.setInputValue("grainOverlap", clean.overlap);
    this.setInputValue("playbackRate", clean.playbackRate);
    this.setInputValue("grainDetune", clean.detune);
    this.input("grainReverse").checked = clean.reverse;
    this.setInputValue("grainPosition", clean.position);
    this.setInputValue("grainJitter", clean.positionJitter);
    this.setInputValue("grainDensity", clean.density);
    this.setInputValue("pitchRandom", clean.pitchRandom);
    this.setInputValue("ampRandom", clean.ampRandom);
    this.setInputValue("pitchShift", clean.pitch);
    this.setInputValue("pitchWindow", clean.pitchWindow);
    this.setInputValue("filterCutoff", clean.filterCutoff);
    this.setInputValue("filterQ", clean.filterQ);
    this.setInputValue("lfoRate", clean.lfoRate);
    this.setInputValue("lfoDepth", clean.lfoDepth);
    this.setInputValue("delayTime", clean.delayTime);
    this.setInputValue("delayFeedback", clean.delayFeedback);
    this.setInputValue("delaySend", clean.delaySend);
    this.setInputValue("reverbDecay", clean.reverbDecay);
    this.setInputValue("reverbPreDelay", clean.reverbPreDelay);
    this.setInputValue("reverbSend", clean.reverbSend);
    this.setInputValue("spatialX", clean.spatialX);
    this.setInputValue("spatialY", clean.spatialY);
    this.setInputValue("spatialZ", clean.spatialZ);
    this.setInputValue("dryBus", clean.dryBus);
    this.setInputValue("labMaster", clean.master);
    this.syncFromControls("preset");
    this.setStatus(status);
  }

  private saveCurrentPreset(): void {
    const name = this.input("presetName").value.trim() || "Untitled Preset";
    const presets = this.loadPresetMap();
    presets[name] = this.readPreset();
    this.savePresetMap(presets);
    this.refreshPresetSelect(name);
    this.setStatus(`Saved ${name}`);
  }

  private loadSelectedPreset(): void {
    const name = this.select("savedSynthPresets").value;
    const preset = this.loadPresetMap()[name];
    if (!preset) {
      this.setStatus("No preset selected");
      return;
    }
    this.input("presetName").value = name;
    this.applyPreset(preset, `Loaded ${name}`);
  }

  private deleteSelectedPreset(): void {
    const select = this.select("savedSynthPresets");
    const name = select.value;
    if (!name) return;
    const presets = this.loadPresetMap();
    delete presets[name];
    this.savePresetMap(presets);
    this.refreshPresetSelect();
    this.setStatus(`Deleted ${name}`);
  }

  private applyPresetJson(): void {
    try {
      const parsed = JSON.parse(this.textarea("synthPresetOutput").value) as Partial<SynthLabPreset>;
      this.applyPreset({ ...DEFAULT_PRESET, ...parsed }, "JSON applied");
    } catch {
      this.setStatus("Invalid preset JSON");
    }
  }

  private refreshPresetSelect(selectedName = ""): void {
    const select = this.select("savedSynthPresets");
    const presets = this.loadPresetMap();
    select.replaceChildren();
    const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
    for (const name of names) {
      const option = document.createElement("option");
      option.value = name;
      option.textContent = name;
      select.append(option);
    }
    if (selectedName) select.value = selectedName;
  }

  private loadPresetMap(): StoredPresetMap {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return {};
      const parsed = JSON.parse(raw) as StoredPresetMap;
      return typeof parsed === "object" && parsed ? parsed : {};
    } catch {
      return {};
    }
  }

  private savePresetMap(presets: StoredPresetMap): void {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
  }

  private sanitizePreset(preset: SynthLabPreset): SynthLabPreset {
    return {
      grainSize: this.clampPresetValue(preset.grainSize, 0.02, 0.6, DEFAULT_PRESET.grainSize),
      fullChain: Boolean(preset.fullChain),
      overlap: this.clampPresetValue(preset.overlap, 0.005, 0.3, DEFAULT_PRESET.overlap),
      playbackRate: this.clampPresetValue(preset.playbackRate, 0.25, 2.5, DEFAULT_PRESET.playbackRate),
      detune: this.clampPresetValue(preset.detune, -2400, 2400, DEFAULT_PRESET.detune),
      reverse: Boolean(preset.reverse),
      position: this.clampPresetValue(preset.position, 0, 1, DEFAULT_PRESET.position),
      positionJitter: this.clampPresetValue(preset.positionJitter, 0, 1, DEFAULT_PRESET.positionJitter),
      density: this.clampPresetValue(preset.density, 1, 80, DEFAULT_PRESET.density),
      pitchRandom: this.clampPresetValue(preset.pitchRandom, 0, 2400, DEFAULT_PRESET.pitchRandom),
      ampRandom: this.clampPresetValue(preset.ampRandom, 0, 1, DEFAULT_PRESET.ampRandom),
      pitch: this.clampPresetValue(preset.pitch, -24, 24, DEFAULT_PRESET.pitch),
      pitchWindow: this.clampPresetValue(preset.pitchWindow, 0.03, 0.16, DEFAULT_PRESET.pitchWindow),
      filterCutoff: this.clampPresetValue(preset.filterCutoff, 80, 9000, DEFAULT_PRESET.filterCutoff),
      filterQ: this.clampPresetValue(preset.filterQ, 0.2, 30, DEFAULT_PRESET.filterQ),
      lfoRate: this.clampPresetValue(preset.lfoRate, 0.02, 12, DEFAULT_PRESET.lfoRate),
      lfoDepth: this.clampPresetValue(preset.lfoDepth, 0, 5000, DEFAULT_PRESET.lfoDepth),
      delayTime: this.clampPresetValue(preset.delayTime, 0.02, 1, DEFAULT_PRESET.delayTime),
      delayFeedback: this.clampPresetValue(preset.delayFeedback, 0, 0.88, DEFAULT_PRESET.delayFeedback),
      delaySend: this.clampPresetValue(preset.delaySend, 0, 1, DEFAULT_PRESET.delaySend),
      reverbDecay: this.clampPresetValue(preset.reverbDecay, 0.2, 12, DEFAULT_PRESET.reverbDecay),
      reverbPreDelay: this.clampPresetValue(preset.reverbPreDelay, 0, 0.5, DEFAULT_PRESET.reverbPreDelay),
      reverbSend: this.clampPresetValue(preset.reverbSend, 0, 1, DEFAULT_PRESET.reverbSend),
      spatialX: this.clampPresetValue(preset.spatialX, -4, 4, DEFAULT_PRESET.spatialX),
      spatialY: this.clampPresetValue(preset.spatialY, -2, 2, DEFAULT_PRESET.spatialY),
      spatialZ: this.clampPresetValue(preset.spatialZ, -6, 2, DEFAULT_PRESET.spatialZ),
      dryBus: this.clampPresetValue(preset.dryBus, 0, 1, DEFAULT_PRESET.dryBus),
      master: this.clampPresetValue(preset.master, 0, 1, DEFAULT_PRESET.master),
    };
  }

  private clampPresetValue(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
  }

  private setInputValue(id: string, value: number): void {
    this.input(id).value = String(value);
  }

  private copyPreset(): void {
    const text = this.textarea("synthPresetOutput").value;
    navigator.clipboard?.writeText(text).then(
      () => this.setStatus("Preset copied"),
      () => this.setStatus("Preset ready")
    );
  }

  private number(id: string): number {
    return Number(this.input(id).value);
  }

  private input(id: string): HTMLInputElement {
    return this.control<HTMLInputElement>(id);
  }

  private button(id: string): HTMLButtonElement {
    return this.control<HTMLButtonElement>(id);
  }

  private select(id: string): HTMLSelectElement {
    return this.control<HTMLSelectElement>(id);
  }

  private textarea(id: string): HTMLTextAreaElement {
    return this.control<HTMLTextAreaElement>(id);
  }

  private control<T extends HTMLElement>(id: string): T {
    const element = this.root.querySelector<T>(`#${id}`);
    if (!element) throw new Error(`Missing synth lab control: ${id}`);
    return element;
  }

  private setStatus(text: string): void {
    const status = this.root.querySelector<HTMLElement>("#synthLabStatus");
    if (status) status.textContent = text;
  }

  private setTransportState(isPlaying: boolean): void {
    this.root.classList.toggle("is-playing", isPlaying);
  }
}
