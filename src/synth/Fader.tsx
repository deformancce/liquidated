export interface FaderSpec<K extends string = string> {
  key: K;
  label: string;
  min: number;
  max: number;
  step: number;
  unit?: string;
  format?: (value: number) => string;
}

export interface FaderGroup<K extends string = string> {
  title: string;
  faders: FaderSpec<K>[];
}

interface FaderProps<K extends string> {
  spec: FaderSpec<K>;
  value: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

export function Fader<K extends string>({ spec, value, onChange, disabled = false }: FaderProps<K>) {
  const text = spec.format ? spec.format(value) : String(value);
  return (
    <label className={`fader ${disabled ? "disabled" : ""}`}>
      <output className="fader-value">{text}</output>
      <input
        className="fader-input"
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <span className="fader-label">{spec.label}</span>
    </label>
  );
}
