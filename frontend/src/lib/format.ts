export const SECTOR_HUES: Record<string, number> = {
  semis: 262,
  bigtech: 217,
  energy: 25,
  defense: 172,
  financials: 330,
  crypto: 48,
  rates: 205,
};

/** A shade of the sector's hue for the i-th holding in that sector. */
export function sectorColor(sector: string, i = 0, alpha = 1): string {
  // Alternate light/dark and drift the hue so neighbouring slices stay distinguishable.
  const hue = (SECTOR_HUES[sector] ?? 0) + i * 9;
  const sat = sector === "rates" ? 30 : 82;
  const light = [62, 44, 72, 52, 36, 66, 48][i % 7];
  return `hsl(${hue} ${sat}% ${light}% / ${alpha})`;
}

export const pct = (x: number, digits = 1) => `${x.toFixed(digits)}%`;

export const signedPct = (x: number, digits = 1) => `${x > 0 ? "+" : x < 0 ? "−" : "±"}${Math.abs(x).toFixed(digits)}%`;

/** Probability shift in percentage points, e.g. -0.13 -> "−13.0 pts". */
export const pts = (delta: number, digits = 1) =>
  `${delta > 0 ? "+" : delta < 0 ? "−" : "±"}${Math.abs(delta * 100).toFixed(digits)} pts`;

export const usd = (x: number) => x.toLocaleString("en-US", { style: "currency", currency: "USD" });

export const compactUsd = (x: number) =>
  x.toLocaleString("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 1 });

export const WINDOW_LABEL = { "1d": "24h", "1w": "7d", "1m": "30d" } as const;

export function tone(x: number, eps = 0.05) {
  return x > eps ? "text-up" : x < -eps ? "text-down" : "text-muted";
}
