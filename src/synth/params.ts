import type { FaderGroup } from "./Fader";
import type { DropletParams } from "./dropletVoice";
import type { FlowParams } from "./flowVoice";
import type { MasterParams } from "./masterBus";
import type { KlonParams } from "./klon";
import type { DecoParams } from "./deco";
import type { ElCapParams } from "./tapeEcho";
import type { BigSkyParams } from "./bigSky";

const pct = (v: number) => `${Math.round(v * 100)}%`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const ms = (v: number) => `${Math.round(v * 1000)} ms`;
const perSec = (v: number) => `${Math.round(v)}/s`;
const oct = (v: number) => `±${v.toFixed(1)} oct`;
const onoff = (v: number) => (v >= 0.5 ? "ON" : "OFF");

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const SCALE_LABELS = ["Major", "Minor", "Maj Pent", "Min Pent"];
const RATE_LABELS = ["1/1", "1/2", "1/4", "1/8", "1/8T", "1/16"];
const note = (v: number) => NOTE_NAMES[Math.round(v)] ?? "?";
const scaleLabel = (v: number) => SCALE_LABELS[Math.round(v)] ?? "?";
const rateLabel = (v: number) => RATE_LABELS[Math.round(v)] ?? "?";

export const DROPLET_GROUPS: FaderGroup<keyof DropletParams>[] = [
  {
    title: "Droplets",
    faders: [
      { key: "density", label: "Density", min: 0, max: 40, step: 0.5, format: perSec },
      { key: "pitch", label: "Pitch", min: 120, max: 4000, step: 10, format: hz },
      { key: "spread", label: "Spread", min: 0, max: 1, step: 0.01, format: oct },
      { key: "sweep", label: "Sweep", min: 0, max: 1, step: 0.01, format: pct },
      { key: "decay", label: "Decay", min: 0.03, max: 0.5, step: 0.005, format: ms },
      { key: "transient", label: "Impact", min: 0, max: 1, step: 0.01, format: pct },
    ],
  },
  {
    title: "Droplet Rhythm",
    faders: [
      { key: "sync", label: "Sync", min: 0, max: 1, step: 1, format: onoff },
      { key: "rate", label: "Rate", min: 0, max: 5, step: 1, format: rateLabel },
      { key: "arp", label: "Arp", min: 0, max: 1, step: 1, format: onoff },
    ],
  },
  {
    title: "Droplet Out",
    faders: [
      { key: "tone", label: "Tone", min: 500, max: 16000, step: 50, format: hz },
      { key: "space", label: "Space", min: 0, max: 1, step: 0.01, format: pct },
      { key: "echo", label: "FX", min: 0, max: 1, step: 0.01, format: pct },
      { key: "level", label: "Level", min: 0, max: 1, step: 0.01, format: pct },
    ],
  },
];

// Pedalboard FX. Ranges mirror the Zoom convention: times in ms, rest 0..100.
const num = (v: number) => `${Math.round(v)}`;

export const KLON_GROUPS: FaderGroup<keyof KlonParams>[] = [
  {
    title: "Klon · Overdrive",
    faders: [
      { key: "gain", label: "Gain", min: 0, max: 100, step: 1, format: num },
      { key: "treble", label: "Treble", min: 0, max: 100, step: 1, format: num },
      { key: "output", label: "Output", min: 0, max: 100, step: 1, format: num },
    ],
  },
];

export const DECO_GROUPS: FaderGroup<keyof DecoParams>[] = [
  {
    title: "Deco · Saturation",
    faders: [
      { key: "saturation", label: "Saturate", min: 0, max: 100, step: 1, format: num },
      { key: "volume", label: "Volume", min: 0, max: 100, step: 1, format: num },
    ],
  },
  {
    title: "Deco · Doubler",
    faders: [
      { key: "lag", label: "Lag", min: 0, max: 100, step: 1, format: num },
      { key: "wobble", label: "Wobble", min: 0, max: 100, step: 1, format: num },
      { key: "blend", label: "Blend", min: 0, max: 100, step: 1, format: num },
      { key: "phase", label: "Phase", min: 0, max: 1, step: 1, format: (v) => (v >= 0.5 ? "OUT" : "IN") },
    ],
  },
];

export const BIGSKY_GROUPS: FaderGroup<keyof BigSkyParams>[] = [
  {
    title: "Big Sky · Reverb",
    faders: [
      { key: "size", label: "Size", min: 0, max: 100, step: 1, format: num },
      { key: "predelay", label: "Pre-Dly", min: 0, max: 100, step: 1, format: num },
      { key: "mod", label: "Mod", min: 0, max: 100, step: 1, format: num },
      { key: "color", label: "Color", min: 0, max: 100, step: 1, format: num },
      { key: "mix", label: "Mix", min: 0, max: 100, step: 1, format: num },
    ],
  },
];

export const ELCAP_GROUPS: FaderGroup<keyof ElCapParams>[] = [
  {
    title: "El Capistan · Tape Echo",
    faders: [
      { key: "time", label: "Time", min: 40, max: 900, step: 1, format: (v) => `${Math.round(v)} ms` },
      { key: "feedback", label: "Feedback", min: 0, max: 100, step: 1, format: num },
      { key: "echoMix", label: "Mix", min: 0, max: 100, step: 1, format: num },
      { key: "echoDamp", label: "Hi Damp", min: 0, max: 100, step: 1, format: num },
      { key: "echoLevel", label: "Level", min: 0, max: 100, step: 1, format: num },
    ],
  },
];

export const MASTER_GROUPS: FaderGroup<keyof MasterParams>[] = [
  {
    title: "Scale & Tempo",
    faders: [
      { key: "quantize", label: "Quantize", min: 0, max: 1, step: 1, format: onoff },
      { key: "root", label: "Root", min: 0, max: 11, step: 1, format: note },
      { key: "scale", label: "Scale", min: 0, max: 3, step: 1, format: scaleLabel },
      { key: "tempo", label: "Tempo", min: 40, max: 200, step: 1, format: (v) => `${Math.round(v)} bpm` },
    ],
  },
  {
    title: "Output",
    faders: [{ key: "master", label: "Master", min: 0, max: 1, step: 0.01, format: pct }],
  },
];

export const FLOW_GROUPS: FaderGroup<keyof FlowParams>[] = [
  {
    title: "Flow Bed",
    faders: [
      { key: "noise", label: "Noise", min: 0, max: 1, step: 0.01, format: pct },
      { key: "lows", label: "Lows", min: 0, max: 1, step: 0.01, format: pct },
      { key: "mids", label: "Mids", min: 0, max: 1, step: 0.01, format: pct },
      { key: "highs", label: "Highs", min: 0, max: 1, step: 0.01, format: pct },
      { key: "movement", label: "Move", min: 0.05, max: 4, step: 0.05, format: (v) => `${v.toFixed(2)} Hz` },
    ],
  },
  {
    title: "Flow Out",
    faders: [
      { key: "bubble", label: "Bubble", min: 0, max: 40, step: 0.5, format: perSec },
      { key: "tone", label: "Tone", min: 500, max: 16000, step: 50, format: hz },
      { key: "space", label: "Space", min: 0, max: 1, step: 0.01, format: pct },
      { key: "echo", label: "FX", min: 0, max: 1, step: 0.01, format: pct },
      { key: "level", label: "Level", min: 0, max: 1, step: 0.01, format: pct },
    ],
  },
];
