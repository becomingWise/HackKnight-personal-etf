// Event risk: how much a basket moves if each linked Polymarket event happens, or doesn't.
//
// A beta is in the weighting engine's units: 1.0 means the stock moves 10% per 100-point odds
// move. A basket's beta to a market is the weighted sum of its holdings' betas. If the event
// happens, odds go from p to 1; if not, from p to 0. Assuming the reaction scales linearly:
//
//   ifYesPct =  100 * (beta_basket / 10) * (1 - p)
//   ifNoPct  = -100 * (beta_basket / 10) * p
//
// p * ifYes + (1 - p) * ifNo = 0: the odds say how much is at stake, not which way to bet.
// This is a scenario stress test, not value at risk, and the betas are hand-set estimates.
import { z } from "zod";
import type { Signal } from "../weights/engine";

export const riskRequestSchema = z.object({
  holdings: z
    .array(z.object({ symbol: z.string().min(1), weightPct: z.number().min(0).max(100) }))
    .min(1),
});

export type RiskRequest = z.infer<typeof riskRequestSchema>;

export type Driver = { symbol: string; weightPct: number; beta: number; ifYesPct: number };

export type MarketRisk = {
  title: string;
  url: string;
  probability: number;
  observedAt: string;
  /** Basket move if the event happens (odds go to 100%), in percent. */
  ifYesPct: number;
  /** Basket move if it doesn't (odds go to 0%), in percent. */
  ifNoPct: number;
  /** Holdings linked to this market, largest contribution first. */
  drivers: Driver[];
};

export type RiskResponse = {
  markets: MarketRisk[];
  /** Holdings no live market is linked to: no measurable event exposure. */
  uncovered: string[];
  basis: string;
  note: string;
};

export const BASIS =
  "Sensitivities are hand-set estimates per stock and market, assumed linear in the odds. " +
  "In our research only some were confirmed by data (e.g. Fed odds → Treasuries, homebuilders).";
export const NOTE =
  "Event probabilities indicate risk, not expected returns: weighted by the market's own odds, " +
  "the expected move is zero.";

/** Percentages are rounded to 3 decimals (0.001 pt). */
const round3 = (x: number) => Math.round(x * 1000) / 1000 + 0;

/** Input the endpoint answers with HTTP 422. */
export class RiskInputError extends Error {}

export function eventRisk(
  req: RiskRequest,
  allSignals: Signal[],
  now: Date = new Date(),
): RiskResponse {
  const keys = req.holdings.map((h) => h.symbol.trim().toUpperCase());
  if (new Set(keys).size !== keys.length) throw new RiskInputError("Duplicate symbols.");
  const total = req.holdings.reduce((sum, h) => sum + h.weightPct, 0);
  if (Math.abs(total - 100) > 0.01) {
    throw new RiskInputError(`Weights must total 100 (got ${total.toFixed(4)}).`);
  }

  const observedAt = now.toISOString();
  const covered = new Set<string>();
  const markets: MarketRisk[] = [];
  for (const s of allSignals) {
    if (s.status !== "live" || s.price === null) continue;
    const p = s.price;
    const drivers: Driver[] = [];
    let basketBeta = 0;
    req.holdings.forEach((h, i) => {
      const beta = s.betas[keys[i]];
      if (!beta) return;
      covered.add(keys[i]);
      basketBeta += (h.weightPct / 100) * beta;
      drivers.push({
        symbol: h.symbol,
        weightPct: h.weightPct,
        beta,
        ifYesPct: round3((h.weightPct / 100) * (beta / 10) * (1 - p) * 100),
      });
    });
    if (!drivers.length) continue;
    drivers.sort((a, b) => Math.abs(b.ifYesPct) - Math.abs(a.ifYesPct));
    const swing = (basketBeta / 10) * 100;
    markets.push({
      title: s.question ?? s.label,
      url: s.url ?? "",
      probability: p,
      observedAt,
      ifYesPct: round3(swing * (1 - p)),
      ifNoPct: round3(-swing * p),
      drivers,
    });
  }

  // Largest swing between the two outcomes first.
  markets.sort((a, b) => Math.abs(b.ifYesPct - b.ifNoPct) - Math.abs(a.ifYesPct - a.ifNoPct));
  return {
    markets,
    uncovered: req.holdings.filter((_, i) => !covered.has(keys[i])).map((h) => h.symbol),
    basis: BASIS,
    note: NOTE,
  };
}
