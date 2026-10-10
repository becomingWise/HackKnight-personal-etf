// Read-only Polymarket access for findStocks: Gamma public search, no auth, no trading endpoints.
import { z } from "zod";

const GAMMA = "https://gamma-api.polymarket.com";
// Polymarket's CDN rejects requests without a user agent.
const HEADERS = {
  "User-Agent": "prophetf/0.1 (hackathon demo, read-only)",
  Accept: "application/json",
};

const numeric = z
  .union([z.number(), z.string()])
  .nullish()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  });

const gammaMarket = z.looseObject({
  id: z.union([z.string(), z.number()]).transform(String),
  question: z.string(),
  active: z.boolean().nullish(),
  closed: z.boolean().nullish(),
  archived: z.boolean().nullish(),
  // JSON text, e.g. "[\"0.039\", \"0.961\"]"; missing on markets that never traded.
  outcomes: z.string().nullish(),
  outcomePrices: z.string().nullish(),
  bestBid: numeric,
  bestAsk: numeric,
  lastTradePrice: numeric,
  liquidityNum: numeric,
  volumeNum: numeric,
  oneWeekPriceChange: numeric,
  endDate: z.string().nullish(),
  description: z.string().nullish(),
  umaResolutionStatus: z.string().nullish(),
  resolutionStatus: z.string().nullish(),
});

const gammaEvent = z.looseObject({
  title: z.string().nullish(),
  slug: z.string(),
  closed: z.boolean().nullish(),
  volume: numeric,
  markets: z.array(z.unknown()).nullish(),
});

const searchResponse = z.looseObject({ events: z.array(z.unknown()).nullish() });

export type MarketCandidate = {
  id: string;
  question: string;
  eventTitle: string;
  url: string;
  /** Reference price of YES in [0,1]: the market's implied probability. */
  probability: number;
  change7d: number | null;
  endDate: string | null;
  volume: number;
  /** Tickers the weighting backend links to this market (empty for free-text search hits). */
  linkedSymbols: string[];
};

type GammaMarket = z.infer<typeof gammaMarket>;

/**
 * Reference price: the midpoint, or the last trade when the spread is wider than 0.10 or a side
 * of the book is empty. Returns null for markets with no real price (never traded, resolved).
 */
export function referencePrice(m: GammaMarket): number | null {
  const bid = m.bestBid;
  const ask = m.bestAsk;
  const hasBook = bid !== undefined && ask !== undefined && bid > 0 && ask < 1 && ask >= bid;
  let price: number | undefined;
  if (hasBook && ask - bid <= 0.1) price = (bid + ask) / 2;
  else if (m.lastTradePrice !== undefined && m.lastTradePrice > 0) price = m.lastTradePrice;
  else if (hasBook) price = (bid + ask) / 2;
  if (price === undefined || !(price > 0 && price < 1)) return null;
  return price;
}

function isYesNo(m: GammaMarket): boolean {
  try {
    const outcomes = JSON.parse(m.outcomes ?? "[]") as unknown;
    return (
      Array.isArray(outcomes) &&
      outcomes.length === 2 &&
      String(outcomes[0]).toLowerCase() === "yes" &&
      String(outcomes[1]).toLowerCase() === "no"
    );
  } catch {
    return false;
  }
}

function isLive(m: GammaMarket): boolean {
  if (!m.active || m.closed || m.archived) return false;
  if (m.resolutionStatus === "resolved" || m.umaResolutionStatus === "resolved") return false;
  return (m.liquidityNum ?? 0) > 0;
}

/** Parses a /public-search payload into live Yes/No markets with a real price. Never throws. */
export function parseSearch(payload: unknown, perEvent = 3): MarketCandidate[] {
  const parsed = searchResponse.safeParse(payload);
  if (!parsed.success) return [];
  const out: MarketCandidate[] = [];
  for (const rawEvent of parsed.data.events ?? []) {
    const event = gammaEvent.safeParse(rawEvent);
    if (!event.success || event.data.closed) continue;
    const markets: { m: GammaMarket; probability: number }[] = [];
    for (const rawMarket of event.data.markets ?? []) {
      const market = gammaMarket.safeParse(rawMarket);
      if (!market.success || !isLive(market.data) || !isYesNo(market.data)) continue;
      const probability = referencePrice(market.data);
      if (probability === null) continue;
      markets.push({ m: market.data, probability });
    }
    markets
      .sort((a, b) => (b.m.volumeNum ?? 0) - (a.m.volumeNum ?? 0))
      .slice(0, perEvent)
      .forEach(({ m, probability }) =>
        out.push({
          id: m.id,
          question: m.question.trim(),
          eventTitle: (event.data.title ?? m.question).trim(),
          url: `https://polymarket.com/event/${event.data.slug}`,
          probability: Math.round(probability * 10000) / 10000,
          change7d: m.oneWeekPriceChange ?? null,
          endDate: m.endDate ?? null,
          volume: m.volumeNum ?? 0,
          linkedSymbols: [],
        }),
      );
  }
  return out;
}

export type SearchMarkets = (query: string, signal?: AbortSignal) => Promise<MarketCandidate[]>;

/** Live markets for one search query. Resolves to [] on any network, HTTP or parsing failure. */
export const searchMarkets: SearchMarkets = async (query, signal) => {
  const url = new URL(`${GAMMA}/public-search`);
  url.searchParams.set("q", query);
  url.searchParams.set("limit_per_type", "8");
  url.searchParams.set("events_status", "active");
  url.searchParams.set("keep_closed_markets", "0");
  const timeout = AbortSignal.timeout(5000);
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    });
    if (!res.ok) return [];
    return parseSearch(await res.json());
  } catch {
    return [];
  }
};
