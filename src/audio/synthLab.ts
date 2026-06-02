import * as Tone from "tone";

type LabControl = HTMLInputElement | HTMLSelectElement;

interface SynthLabPreset {
  grainSize: number;
  overlap: number;
  playbackRate: number;
  detune: number;
  reverse: boolean;
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
  grainSize: 0.12,
  overlap: 0.06,
  playbackRate: 1,
  detune: 0,
  reverse: false,
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

export class SynthLab {
  private root: HTMLElement;
  private player: Tone.GrainPlayer | null = null;
  private objectUrl: string | null = null;
  private playing = false;
  private restartTimer = 0;
  private master = new Tone.Gain(DEFAULT_PRESET.master).toDestination();
  private dryBus = new Tone.Gain(DEFAULT_PRESET.dryBus).connect(this.master);
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
    wet: DEFAULT_PRESET.delaySend,
  });
  private reverb = new Tone.Reverb({
    decay: DEFAULT_PRESET.reverbDecay,
    preDelay: DEFAULT_PRESET.reverbPreDelay,
    wet: DEFAULT_PRESET.reverbSend,
  });

  constructor(root: HTMLElement) {
    this.root = root;
    this.lfo.connect(this.lfoFilter.frequency);
    this.bind();
    this.syncFromControls();
  }

  private bind(): void {
    this.button("synthLabToggle").addEventListener("click", () => {
      this.root.classList.toggle("collapsed");
    });
    this.input("sampleFile").addEventListener("change", (event) => {
      const file = (event.target as HTMLInputElement).files?.[0];
      if (file) this.loadFile(file);
    });
    this.button("grainPlay").addEventListener("click", () => this.play());
    this.button("grainStop").addEventListener("click", () => this.stop());
    this.button("grainRestart").addEventListener("click", () => this.restart());
    this.button("copySynthPreset").addEventListener("click", () => this.copyPreset());

    for (const control of this.root.querySelectorAll<LabControl>("input[data-synth], select[data-synth]")) {
      control.addEventListener("input", () => this.syncFromControls(control.id));
      control.addEventListener("change", () => this.syncFromControls(control.id));
    }
  }

  private async loadFile(file: File): Promise<void> {
    this.setStatus(`Loading ${file.name}`);
    this.stop();
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = URL.createObjectURL(file);
    this.player?.dispose();
    this.player = new Tone.GrainPlayer({
      url: this.objectUrl,
      loop: true,
      onload: () => {
        this.setStatus(file.name);
        this.syncFromControls();
      },
      onerror: (error) => this.setStatus(error.message),
    });
    this.connectPlayer();
  }

  private connectPlayer(): void {
    if (!this.player) return;
    this.player.disconnect();
    this.delay.disconnect();
    this.reverb.disconnect();
    this.spatial.disconnect();
    this.player.chain(this.pitchShift, this.lfoFilter, this.delay, this.reverb, this.spatial, this.dryBus);
    this.setStatus("Serial: Grain -> Pitch -> LFO Filter -> Delay -> Reverb -> 3D");
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
    this.master.gain.rampTo(preset.master, 0.05);
    this.dryBus.gain.rampTo(preset.dryBus, 0.05);
    this.pitchShift.pitch = preset.pitch;
    this.pitchShift.windowSize = preset.pitchWindow;
    this.lfoFilter.frequency.rampTo(preset.filterCutoff, 0.05);
    this.lfoFilter.Q.rampTo(preset.filterQ, 0.05);
    this.lfo.frequency.rampTo(preset.lfoRate, 0.05);
    this.lfo.min = Math.max(20, preset.filterCutoff - preset.lfoDepth);
    this.lfo.max = preset.filterCutoff + preset.lfoDepth;
    this.delay.delayTime.rampTo(preset.delayTime, 0.05);
    this.delay.feedback.rampTo(preset.delayFeedback, 0.05);
    this.delay.wet.rampTo(preset.delaySend, 0.05);
    this.reverb.decay = preset.reverbDecay;
    this.reverb.preDelay = preset.reverbPreDelay;
    this.reverb.wet.rampTo(preset.reverbSend, 0.05);
    this.spatial.setPosition(preset.spatialX, preset.spatialY, preset.spatialZ);

    if (this.player) {
      this.player.grainSize = preset.grainSize;
      this.player.overlap = preset.overlap;
      this.player.playbackRate = Math.max(0.05, preset.playbackRate);
      this.player.detune = preset.detune;
      this.player.reverse = preset.reverse;
    }

    if (this.isGranularControl(changedId)) {
      this.scheduleAudibleRestart();
    }

    this.writePreset(preset);
  }

  private isGranularControl(id: string): boolean {
    return ["grainSize", "grainOverlap", "playbackRate", "grainDetune", "grainReverse"].includes(id);
  }

  private scheduleAudibleRestart(): void {
    if (!this.player || !this.playing) return;
    window.clearTimeout(this.restartTimer);
    this.restartTimer = window.setTimeout(() => {
      this.player?.restart();
      this.setStatus("Granular settings applied");
    }, 120);
  }

  private readPreset(): SynthLabPreset {
    return {
      grainSize: this.number("grainSize"),
      overlap: this.number("grainOverlap"),
      playbackRate: this.number("playbackRate"),
      detune: this.number("grainDetune"),
      reverse: this.input("grainReverse").checked,
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
