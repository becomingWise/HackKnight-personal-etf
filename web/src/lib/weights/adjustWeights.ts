// TypeScript port of POST /api/weights in /backend/src/polyslice_api/main.py (adjust_weights).
// The Python version is the reference; keep this in step with it (see CLAUDE.md, "Weights parity").
import { z } from "zod";
import {
  explain,
  relevantSignals,
  reweight,
  roundWeights,
  type Signal,
  type Window,
} from "./engine";

export const WEIGHTS_WINDOW: Window = "1w";
export const WEIGHTS_SENSITIVITY = 2.0;

export const weightsRequestSchema = z.object({
  idea: z.string().min(1),
  holdings: z
    .array(z.object({ symbol: z.string().min(1), weightPct: z.number().min(0).max(100) }))
    .min(1),
});

export type WeightsRequest = z.infer<typeof weightsRequestSchema>;

export type Evidence = {
  title: string;
  url: string;
  outcome: "Yes";
  probability: number;
  observedAt: string;
  change7d: number | null;
  symbols: string[];
};

export type WeightsResponse = {
  status: "adjusted" | "unchanged";
  holdings: { symbol: string; weightPct: number }[];
  explanation: string;
  evidence: Evidence[];
};

/** Input the Python service answers with HTTP 422 and `{"detail": message}`. */
export class WeightsInputError extends Error {}

export function adjustWeights(
  req: WeightsRequest,
  allSignals: Signal[],
  now: Date = new Date(),
): WeightsResponse {
  const symbols = req.holdings.map((h) => h.symbol);
  if (new Set(symbols).size !== symbols.length) throw new WeightsInputError("Duplicate symbols.");
  const total = req.holdings.reduce((sum, h) => sum + h.weightPct, 0);
  if (Math.abs(total - 100) > 0.01) {
    throw new WeightsInputError(`Weights must total 100 (got ${total.toFixed(4)}).`);
  }

  const live = allSignals.filter((s) => s.status === "live");
  const holdings = req.holdings.map((h) => ({
    symbol: h.symbol.trim().toUpperCase(),
    name: h.symbol,
    base: h.weightPct,
  }));
  const relevant = relevantSignals(holdings, live);
  const unchanged = req.holdings.map((h) => ({ symbol: h.symbol, weightPct: h.weightPct }));
  if (!relevant.length) {
    return {
      holdings: unchanged,
      status: "unchanged",
      evidence: [],
      explanation:
        "None of the live Polymarket markets PolySlice tracks are linked to these stocks, " +
        "so the starting percentages are unchanged.",
    };
  }

  const rows = reweight(holdings, relevant, {
    window: WEIGHTS_WINDOW,
    sensitivity: WEIGHTS_SENSITIVITY,
  });
  const rounded = roundWeights(rows.map((r) => r.weight_pct));
  const observedAt = now.toISOString();
  const held = new Set(holdings.map((h) => h.symbol));
  const change = (s: Signal) => s.changes?.[WEIGHTS_WINDOW];
  const evidence: Evidence[] = [...relevant]
    .sort((a, b) => Math.abs(change(b) || 0) - Math.abs(change(a) || 0))
    .map((s) => ({
      title: s.question ?? s.label,
      url: s.url ?? "",
      outcome: "Yes" as const,
      probability: s.price ?? 0,
      observedAt,
      change7d: change(s) ?? null,
      symbols: Object.keys(s.betas)
        .filter((sym) => held.has(sym))
        .sort(),
    }));

  if (rounded.every((w, i) => Math.abs(w - req.holdings[i].weightPct) < 0.005)) {
    return {
      holdings: unchanged,
      status: "unchanged",
      evidence,
      explanation:
        `${relevant.length} related Polymarket market(s) barely moved in the past week, ` +
        "so the starting percentages are unchanged.",
    };
  }
  return {
    status: "adjusted",
    holdings: req.holdings.map((h, i) => ({ symbol: h.symbol, weightPct: rounded[i] })),
    explanation: explain(rows, relevant, WEIGHTS_WINDOW),
    evidence,
  };
}
