// Saved baskets. POST /api/baskets takes the responses of /api/stocks and /api/weights as they
// are (extra fields are ignored), so the frontend can save with one call after the weights step.
import { z } from "zod";

const text = (max: number) => z.string().trim().min(1).max(max);
const probability = z.number().min(0).max(1);
const httpUrl = z.url({ protocol: /^https?$/ }).max(500);

/** The body of a /api/stocks response (or the controller's `{ summary, stocks }`). */
const stocksPart = z.object({
  summary: z.string().trim().max(3000),
  stocks: z
    .array(
      z.object({
        symbol: text(20),
        name: text(120),
        // /api/stocks no longer returns reasons (2026-10-10); older clients may still send them.
        reason: z.string().trim().max(1000).default(""),
        marketId: z.string().max(40).nullish(),
      }),
    )
    .min(1)
    .max(10),
  source: z.enum(["gemini", "fallback"]).nullish(),
  markets: z
    .array(
      z.object({
        id: text(40),
        title: text(400),
        url: httpUrl,
        probability,
        observedAt: z.string().max(40),
      }),
    )
    .max(20)
    .nullish(),
});

/** The body of a /api/weights response (or the controller's adjustment + holdings). */
const weightsPart = z.object({
  status: z.enum(["adjusted", "unchanged", "unavailable"]),
  holdings: z
    .array(z.object({ symbol: text(20), weightPct: z.number().min(0).max(100) }))
    .min(1)
    .max(10),
  explanation: z.string().trim().max(4000),
  evidence: z
    .array(
      z.object({
        title: text(400),
        url: httpUrl,
        probability,
        observedAt: z.string().max(40),
        change7d: z.number().nullish(),
        symbols: z.array(z.string().max(20)).max(40).nullish(),
      }),
    )
    .max(30)
    .default([]),
});

export const saveBasketSchema = z.object({
  idea: text(500),
  stocks: stocksPart,
  /** Omit or null when the weights step was skipped or failed: equal weights are stored. */
  weights: weightsPart.nullish(),
});

export type SaveBasketInput = z.infer<typeof saveBasketSchema>;

export type BasketMarket = {
  /** Polymarket market id; null when the market could not be identified (not tracked). */
  id: string | null;
  title: string;
  url: string;
  outcome: "Yes";
  /** Odds observed when the basket was created. */
  probability: number;
  observedAt: string;
  change7d: number | null;
  citedBy: ("stocks" | "weights")[];
};

export type Basket = {
  id: string;
  url: string;
  createdAt: string;
  idea: string;
  summary: string;
  source: "gemini" | "fallback" | null;
  stocks: {
    symbol: string;
    name: string;
    reason: string;
    marketId: string | null;
    weightPct: number;
  }[];
  weights: {
    status: "adjusted" | "unchanged" | "unavailable";
    explanation: string;
    holdings: { symbol: string; weightPct: number }[];
    evidence: {
      title: string;
      url: string;
      outcome: "Yes";
      probability: number;
      observedAt: string;
      change7d: number | null;
      symbols: string[];
    }[];
  };
  markets: BasketMarket[];
};

export class BasketInputError extends Error {}

/** Equal starting weights totalling exactly 100, the same rule as the controller's. */
export function equalWeights(symbols: string[]): { symbol: string; weightPct: number }[] {
  const cents = Math.floor(10000 / symbols.length);
  return symbols.map((symbol, i) => ({
    symbol,
    weightPct: (i === symbols.length - 1 ? 10000 - cents * i : cents) / 100,
  }));
}

/**
 * Turns a validated request into the stored basket (without id, url and createdAt).
 * `marketIdFor` maps a weights evidence item to its Polymarket market id when known.
 */
export function buildBasket(
  input: SaveBasketInput,
  marketIdFor: (evidence: { title: string; url: string }) => string | null = () => null,
): Omit<Basket, "id" | "url" | "createdAt"> {
  const symbols = input.stocks.stocks.map((s) => s.symbol);
  if (new Set(symbols).size !== symbols.length) {
    throw new BasketInputError("stocks.stocks has duplicate symbols.");
  }

  let weights: Basket["weights"];
  if (input.weights) {
    const held = input.weights.holdings.map((h) => h.symbol);
    if (held.length !== symbols.length || !symbols.every((s) => held.includes(s))) {
      throw new BasketInputError(
        "weights.holdings must contain exactly the symbols in stocks.stocks.",
      );
    }
    const total = input.weights.holdings.reduce((sum, h) => sum + h.weightPct, 0);
    if (Math.abs(total - 100) > 0.011) {
      throw new BasketInputError(`weights.holdings must total 100 (got ${total.toFixed(2)}).`);
    }
    weights = {
      status: input.weights.status,
      explanation: input.weights.explanation,
      holdings: symbols.map((symbol) => ({
        symbol,
        weightPct: input.weights!.holdings.find((h) => h.symbol === symbol)!.weightPct,
      })),
      evidence: input.weights.evidence.map((e) => ({
        title: e.title,
        url: e.url,
        outcome: "Yes" as const,
        probability: e.probability,
        observedAt: e.observedAt,
        change7d: e.change7d ?? null,
        symbols: e.symbols ?? [],
      })),
    };
  } else {
    weights = {
      status: "unavailable",
      explanation:
        "No weight adjustment was saved with this basket; the stocks are equally weighted.",
      holdings: equalWeights(symbols),
      evidence: [],
    };
  }

  // Cited markets, de-duplicated by id (or by URL + title when the id is unknown).
  const markets = new Map<string, BasketMarket>();
  for (const m of input.stocks.markets ?? []) {
    markets.set(`id:${m.id}`, {
      id: m.id,
      title: m.title,
      url: m.url,
      outcome: "Yes",
      probability: m.probability,
      observedAt: m.observedAt,
      change7d: null,
      citedBy: ["stocks"],
    });
  }
  for (const e of weights.evidence) {
    const id = marketIdFor(e);
    const key = id ? `id:${id}` : `ref:${e.url}|${e.title}`;
    const existing = markets.get(key);
    if (existing) {
      existing.citedBy = [...new Set([...existing.citedBy, "weights" as const])];
      existing.change7d ??= e.change7d;
    } else {
      markets.set(key, {
        id,
        title: e.title,
        url: e.url,
        outcome: "Yes",
        probability: e.probability,
        observedAt: e.observedAt,
        change7d: e.change7d,
        citedBy: ["weights"],
      });
    }
  }

  const weightOf = new Map(weights.holdings.map((h) => [h.symbol, h.weightPct]));
  return {
    idea: input.idea,
    summary: input.stocks.summary,
    source: input.stocks.source ?? null,
    stocks: input.stocks.stocks.map((s) => ({
      symbol: s.symbol,
      name: s.name,
      reason: s.reason,
      marketId: s.marketId ?? null,
      weightPct: weightOf.get(s.symbol)!,
    })),
    weights,
    markets: [...markets.values()],
  };
}
