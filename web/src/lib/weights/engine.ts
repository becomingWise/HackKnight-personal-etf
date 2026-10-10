// TypeScript port of the weighting math in /backend/src/polyslice_api/engine.py.
//
// THE PYTHON ENGINE IS THE REFERENCE. Any change there must be mirrored here, then
// `pnpm parity:weights` and `pnpm test` rerun (see CLAUDE.md, "Weights parity").
//
//   multiplier_i = clip(1 + k * sum_s beta_is * (P_s - P_ref_s), 0, MAX_MULTIPLIER)
//   weight_i     = base_i * multiplier_i / sum_j base_j * multiplier_j

export type Window = "1d" | "1w" | "1m";
export const MAX_MULTIPLIER = 3.0;

/** A Polymarket market with a sensitivity (beta) per ticker, as resolved from the universe. */
export type Signal = {
  id: string;
  label: string;
  betas: Record<string, number>;
  status?: "live" | "unavailable";
  /** Current probability of Yes; null when the market could not be resolved. */
  price: number | null;
  question?: string;
  /** Polymarket ids of the resolved market. Internal: never part of the /api/weights response. */
  marketId?: string;
  tokenIds?: string[];
  endDate?: string | null;
  url?: string;
  changes?: Partial<Record<Window, number | null>> | null;
};

export type Holding = { symbol: string; name?: string; base: number };

export type Contribution = { signal: string; beta: number; delta: number; effect: number };

export type Row = Omit<Holding, "base"> & {
  multiplier: number;
  contributions: Contribution[];
  base_pct: number;
  weight_pct: number;
  change_pct: number;
};

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

/** The probability now, at the window start, and the shift between them. */
export function signalMove(
  signal: Signal,
  window: Window,
  overrides: Record<string, number>,
): { now: number; ref: number; live: number; delta: number } | null {
  if (signal.price === null || signal.price === undefined) return null;
  const live = signal.price;
  const change = signal.changes?.[window] || 0.0;
  const ref = clamp(live - change, 0.0, 1.0);
  const now = clamp(overrides[signal.id] ?? live, 0.0, 1.0);
  return { now, ref, live, delta: now - ref };
}

type Sector = { id: string; holdings: { symbol: string; name?: string; base: number }[] };

/** Holdings for the chosen sectors; each sector gets an equal share of the basket. */
export function scopeHoldings(
  sectors: Sector[],
  scope: string[],
): (Holding & { sector: string })[] {
  const chosen = sectors.filter((s) => scope.includes(s.id));
  if (!chosen.length) return [];
  const share = 100.0 / chosen.length;
  const seen = new Map<string, Holding & { sector: string }>();
  for (const sector of chosen) {
    const total = sector.holdings.reduce((sum, h) => sum + h.base, 0);
    for (const h of sector.holdings) {
      const base = (share * h.base) / total;
      const existing = seen.get(h.symbol);
      if (existing) existing.base += base;
      else seen.set(h.symbol, { ...h, base, sector: sector.id });
    }
  }
  return [...seen.values()];
}

export function reweight(
  holdings: Holding[],
  signals: Signal[],
  {
    window = "1w",
    sensitivity = 2.0,
    overrides = {},
  }: { window?: Window; sensitivity?: number; overrides?: Record<string, number> } = {},
): Row[] {
  const moves = new Map(signals.map((s) => [s.id, signalMove(s, window, overrides)]));

  const partial = holdings.map((h) => {
    const contributions: Contribution[] = [];
    for (const s of signals) {
      const beta = s.betas[h.symbol];
      const move = moves.get(s.id);
      if (!beta || !move) continue;
      contributions.push({
        signal: s.id,
        beta,
        delta: move.delta,
        effect: sensitivity * beta * move.delta,
      });
    }
    // Array.prototype.sort is stable, like Python's sort.
    contributions.sort((a, b) => Math.abs(b.effect) - Math.abs(a.effect));
    const multiplier = clamp(
      1.0 + contributions.reduce((sum, c) => sum + c.effect, 0),
      0.0,
      MAX_MULTIPLIER,
    );
    return { ...h, multiplier, contributions };
  });

  const rawTotal = partial.reduce((sum, r) => sum + r.base * r.multiplier, 0);
  const baseTotal = partial.reduce((sum, r) => sum + r.base, 0) || 1.0;
  return partial.map(({ base, ...rest }) => {
    const base_pct = (100.0 * base) / baseTotal;
    // If every holding is zeroed out, fall back to the base weights.
    const weight_pct = rawTotal > 0 ? (100.0 * base * rest.multiplier) / rawTotal : base_pct;
    return { ...rest, base_pct, weight_pct, change_pct: weight_pct - base_pct };
  });
}

/** Signals with a beta entry for at least one holding. */
export function relevantSignals<S extends Signal>(
  holdings: { symbol: string }[],
  signals: S[],
): S[] {
  const symbols = new Set(holdings.map((h) => h.symbol));
  return signals.filter((s) => Object.keys(s.betas).some((sym) => symbols.has(sym)));
}

/** Round percentages so they still total exactly 100 (largest remainder). */
export function roundWeights(weightsPct: number[], decimals = 2): number[] {
  const scale = 10 ** decimals;
  const exact = weightsPct.map((w) => w * scale);
  const floors = exact.map((x) => Math.trunc(x));
  const order = exact
    .map((_, i) => i)
    .sort((a, b) => exact[b] - floors[b] - (exact[a] - floors[a]));
  const missing = 100 * scale - floors.reduce((sum, f) => sum + f, 0);
  // slice(0, n) matches Python's order[:n], including for a negative n.
  for (const i of order.slice(0, missing)) floors[i] += 1;
  return floors.map((f) => f / scale);
}

/** Python's round(): ties go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const floor = Math.floor(x);
  const diff = x - floor;
  if (diff === 0.5) return floor % 2 === 0 ? floor : floor + 1;
  return Math.round(x);
}

/**
 * Python's f"{x:.{decimals}f}" for non-negative x. Both languages round the exact binary value;
 * they differ only on true ties (toFixed rounds up, Python rounds to even). A double is a true
 * tie at that many places exactly when x * 2^(decimals + 1) is an odd integer.
 */
export function formatFixed(x: number, decimals: number): string {
  const probe = x * 2 ** (decimals + 1);
  if (Number.isInteger(probe) && Math.abs(probe) % 2 === 1) {
    const scaled = x * 10 ** decimals; // exact here: x is a small dyadic fraction
    const lower = Math.floor(scaled);
    return ((lower % 2 === 0 ? lower : lower + 1) / 10 ** decimals).toFixed(decimals);
  }
  return x.toFixed(decimals);
}

/** Plain-English summary of which odds moves drove the biggest weight changes. */
export function explain(rows: Row[], signals: Signal[], window: Window): string {
  const span = { "1d": "day", "1w": "week", "1m": "month" }[window];
  const labels = new Map(signals.map((s) => [s.id, s]));
  const movers = [...rows]
    .sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct))
    .slice(0, 3);
  const parts: string[] = [];
  for (const r of movers) {
    if (Math.abs(r.change_pct) < 0.05 || !r.contributions.length) continue;
    const move = `${r.symbol} ${formatFixed(r.base_pct, 1)}% → ${formatFixed(r.weight_pct, 1)}%`;
    const c = r.contributions[0];
    if (c.effect > 0 !== r.change_pct > 0) {
      // Its own signal pushed the other way; it moved because other holdings moved more.
      parts.push(
        r.change_pct < 0
          ? `${move} (diluted as other holdings grew)`
          : `${move} (as other holdings shrank)`,
      );
      continue;
    }
    const top = labels.get(c.signal)!;
    const pts = Math.abs(c.delta * 100);
    parts.push(
      `${move} (“${top.question}” ${c.delta > 0 ? "up" : "down"} ` +
        `${formatFixed(pts, 0)} ${roundHalfEven(pts) === 1 ? "pt" : "pts"} to ${formatFixed((top.price ?? 0) * 100, 0)}%)`,
    );
  }
  const detail = parts.length
    ? ": " + parts.join("; ")
    : ", with only small changes to each holding";
  return (
    `Tilted by Polymarket odds moves over the past ${span}${detail}. ` +
    "Event probabilities indicate risk, not expected returns."
  );
}
