import type { FaderGroup } from "./Fader";
import type { GrainParams } from "./grainSynth";
import type { AmbientParams } from "./ambientPad";

const ms = (v: number) => `${Math.round(v * 1000)} ms`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const hz = (v: number) => (v >= 1000 ? `${(v / 1000).toFixed(1)} kHz` : `${Math.round(v)} Hz`);
const st = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v)} st`;

export const FADER_GROUPS: FaderGroup<keyof GrainParams>[] = [
  {
    title: "Grain",
    faders: [
      { key: "grainSize", label: "Size", min: 0.02, max: 0.6, step: 0.005, format: ms },
      { key: "density", label: "Density", min: 1, max: 80, step: 1, format: (v) => `${Math.round(v)}/s` },
      { key: "overlap", label: "Fade", min: 0.005, max: 0.3, step: 0.005, format: ms },
      { key: "position", label: "Position", min: 0, max: 1, step: 0.01, format: pct },
      { key: "spray", label: "Spray", min: 0, max: 1, step: 0.01, format: pct },
      { key: "reverse", label: "Reverse", min: 0, max: 1, step: 1, format: (v) => (v >= 0.5 ? "ON" : "OFF") },
    ],
  },
  {
    title: "Pitch",
    faders: [
      { key: "pitch", label: "Pitch", min: -24, max: 24, step: 1, format: st },
      { key: "playbackRate", label: "Speed", min: 0.25, max: 2.5, step: 0.01, format: (v) => `${v.toFixed(2)}x` },
      { key: "pitchSpray", label: "P.Spray", min: 0, max: 1200, step: 10, format: (v) => `${Math.round(v)} ct` },
      { key: "ampSpray", label: "A.Spray", min: 0, max: 1, step: 0.01, format: pct },
      { key: "filterCutoff", label: "Tone", min: 200, max: 16000, step: 50, format: hz },
    ],
  },
  {
    title: "Delay",
    faders: [
      { key: "delayTime", label: "Time", min: 0.02, max: 1, step: 0.01, format: ms },
      { key: "delayFeedback", label: "Feedback", min: 0, max: 0.9, step: 0.01, format: pct },
      { key: "delayMix", label: "Mix", min: 0, max: 1, step: 0.01, format: pct },
    ],
  },
  {
    title: "Reverb",
    faders: [
      { key: "reverbDecay", label: "Decay", min: 0.2, max: 12, step: 0.1, format: (v) => `${v.toFixed(1)} s` },
      { key: "reverbMix", label: "Mix", min: 0, max: 1, step: 0.01, format: pct },
    ],
  },
  {
    title: "Out",
    faders: [{ key: "master", label: "Master", min: 0, max: 1, step: 0.01, format: pct }],
  },
];

export const AMBIENT_GROUPS: FaderGroup<keyof AmbientParams>[] = [
  {
    title: "Ambient Pad",
    faders: [
      { key: "level", label: "Level", min: 0, max: 1, step: 0.01, format: pct },
      { key: "pitch", label: "Pitch", min: -24, max: 24, step: 1, format: st },
      { key: "tone", label: "Tone", min: 200, max: 8000, step: 50, format: hz },
      { key: "movement", label: "Move", min: 0.01, max: 1, step: 0.01, format: (v) => `${v.toFixed(2)} Hz` },
      { key: "width", label: "Width", min: 0, max: 1, step: 0.01, format: pct },
      { key: "shimmer", label: "Shimmer", min: 0, max: 1, step: 0.01, format: pct },
      { key: "space", label: "Space", min: 0, max: 1, step: 0.01, format: pct },
    ],
  },
];
