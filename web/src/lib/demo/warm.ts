// Keeps the demo ideas answered from the cache: pre-computes /api/stocks and the /api/weights
// request the frontend sends next (equal starting weights), and refreshes them before they
// expire. A failed refresh never replaces a good answer.
import {
  CACHE_TTL_SECONDS,
  stocksCacheKey,
  tigerApiCache,
  weightsCacheKey,
  type ApiCache,
} from "../cache/apiCache";
import { equalWeights } from "../baskets/schema";
import { computeStocks, defaultStocksDeps, type HandlerDeps } from "../pipeline/handler";
import { adjustWeights } from "../weights/adjustWeights";
import type { Signal } from "../weights/engine";
import { liveSignals } from "../weights/signals";

export const DEMO_IDEAS = [
  "AI chips and Taiwan risk",
  "Fed rate cuts and housing",
  "Clean energy after the election",
  "Crypto regulation",
] as const;

export type WarmDeps = {
  stocks: HandlerDeps;
  signals: () => Promise<Signal[]>;
  cache: ApiCache;
};

export const defaultWarmDeps: WarmDeps = {
  stocks: defaultStocksDeps,
  signals: liveSignals,
  cache: tigerApiCache,
};

export type WarmReport = {
  idea: string;
  /** refreshed: new AI answer cached. kept: refresh failed, previous answer extended. failed: nothing cached. */
  result: "refreshed" | "kept" | "failed";
  source: "gemini" | "fallback" | null;
  symbols: string[];
  weights: "adjusted" | "unchanged" | null;
  expiresAt: string | null;
  ms: number;
};

export async function warmIdea(
  idea: string,
  deps: WarmDeps = defaultWarmDeps,
): Promise<WarmReport> {
  const started = Date.now();
  const key = stocksCacheKey(idea);
  const report = (partial: Partial<WarmReport>): WarmReport => ({
    idea,
    result: "failed",
    source: null,
    symbols: [],
    weights: null,
    expiresAt: null,
    ms: Date.now() - started,
    ...partial,
  });

  let stocks;
  try {
    stocks = await computeStocks(idea, deps.stocks);
  } catch {
    stocks = null;
  }

  if (!stocks || stocks.source !== "gemini") {
    // Gemini is unavailable: keep serving the last AI answer rather than a keyword fallback.
    const kept = await deps.cache.extend("stocks", key);
    const previous = kept
      ? await deps.cache.get<{ stocks: { symbol: string }[] }>("stocks", key)
      : null;
    if (previous) {
      const holdings = equalWeights(previous.value.stocks.map((s) => s.symbol));
      await deps.cache.extend("weights", weightsCacheKey(holdings));
    }
    return report({
      result: previous ? "kept" : "failed",
      source: stocks?.source ?? null,
      symbols: previous?.value.stocks.map((s) => s.symbol) ?? [],
      expiresAt: previous?.expiresAt.toISOString() ?? null,
    });
  }

  await deps.cache.set("stocks", key, stocks);

  // The request the controller sends after findStocks: the same symbols, equally weighted.
  const holdings = equalWeights(stocks.stocks.map((s) => s.symbol));
  let weightsStatus: WarmReport["weights"] = null;
  try {
    const weights = adjustWeights({ idea, holdings }, await deps.signals());
    await deps.cache.set("weights", weightsCacheKey(holdings), weights);
    weightsStatus = weights.status;
  } catch {
    weightsStatus = null;
  }

  return report({
    result: "refreshed",
    source: "gemini",
    symbols: stocks.stocks.map((s) => s.symbol),
    weights: weightsStatus,
    expiresAt: new Date(Date.now() + CACHE_TTL_SECONDS * 1000).toISOString(),
  });
}

/** The demo idea whose cached answer is missing or expires first. */
export async function stalestIdea(cache: ApiCache = tigerApiCache): Promise<string> {
  const expiries = await Promise.all(
    DEMO_IDEAS.map(async (idea) => ({
      idea,
      at: (await cache.expiresAt("stocks", stocksCacheKey(idea)))?.getTime() ?? 0,
    })),
  );
  return expiries.sort((a, b) => a.at - b.at)[0].idea;
}

export async function demoStatus(cache: ApiCache = tigerApiCache) {
  return Promise.all(
    DEMO_IDEAS.map(async (idea) => {
      const expiresAt = await cache.expiresAt("stocks", stocksCacheKey(idea));
      return {
        idea,
        cached: expiresAt !== null,
        expiresAt: expiresAt?.toISOString() ?? null,
        secondsLeft: expiresAt ? Math.round((expiresAt.getTime() - Date.now()) / 1000) : 0,
      };
    }),
  );
}
