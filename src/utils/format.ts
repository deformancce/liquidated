export function money(value: number): string {
  if (value >= 1_000_000) return `$${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `$${(value / 1_000).toFixed(0)}K`;
  return `$${value.toFixed(0)}`;
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function formatPrice(value: number, decimals: number): string {
  return value.toLocaleString(undefined, {
    minimumFractionDigits: value > 100 ? 0 : Math.min(decimals, 2),
    maximumFractionDigits: decimals,
  });
}
