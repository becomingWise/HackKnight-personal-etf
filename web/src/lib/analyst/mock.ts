// The MOCK analyst: an EvidencePacket built by code we already had: Polymarket search, the
// weighting universe's market → ticker links, and the odds history in Tiger. Its only LLM step
// is the optional search plan (./plan.ts); without it, keywords pick the sectors and queries.
// The real analyst replaces it (docs/HANDOFF.md) and only has to return the same packet.
import type { PastOdds } from "../odds/repo";
import type { MarketCandidate, SearchMarkets } from "../polymarket/search";
import { formatOdds } from "../stocks/contract";
import {
  SECTORS,
  STOCKS,
  STOCK_BY_SYMBOL,
  keywordHits,
  matchSectors,
  signalsForSectors,
  type UniverseSignal,
} from "../stocks/universe";
import type { Analyst, EvidencePacket, Signal } from "./packet";
import type { Planner } from "./plan";

const MAX_SEARCHES = 10;
const MAX_MARKETS = 15;

/** What one market means, independent of the idea. The Tiger analyst supplies these from a table. */
export type MarketAnalysis = {
  signal: Signal;
  analystNote: string;
  tickers: { symbol: string; impact: number; why: string }[];
};

export type MockAnalystDeps = {
  search: SearchMarkets;
  /** Turns the idea into search queries and sectors with one LLM call; keywords are used without it. */
  plan?: Planner;
  /** Odds 24 hours and 7 days ago from Tiger; Polymarket's own change fields fill the gaps. */
  pastOdds?: (ids: string[], now: Date) => Promise<PastOdds>;
  /** Analysis written by the real analyst for some of the markets; overrides the mock's. */
  analyses?: (ids: string[]) => Promise<Map<string, MarketAnalysis>>;
  now?: () => Date;
};

const round = (value: number, digits: number) => {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
};
const clamp = (value: number, min = -1, max = 1) => Math.min(max, Math.max(min, value));

const STOP_WORDS = new Set(
  "a an and are as at be by for from if in into is it of on or over that the this to will with".split(
    " ",
  ),
);

function tokens(text: string): Set<string> {
  const words = text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  // A trailing "s" is dropped so "chips" meets "chip".
  return new Set(words.filter((w) => !STOP_WORDS.has(w)).map((w) => w.replace(/s$/, "")));
}

/**
 * 0 to 1: a market the universe links to the idea's sectors starts at 0.5, a text hit at 0.3;
 * words shared with the idea, or with the planned query that found the market, add up to 0.5.
 */
export function relevance(idea: string, market: MarketCandidate, query?: string): number {
  const found = tokens(`${market.question} ${market.eventTitle}`);
  const share = (text: string) => {
    const wanted = tokens(text);
    return wanted.size ? [...wanted].filter((w) => found.has(w)).length / wanted.size : 0;
  };
  // A planned query is one step away from the idea, so its words count a little less.
  const overlap = Math.max(share(idea), query ? 0.8 * share(query) : 0);
  return round(clamp((market.linkedSymbols.length ? 0.5 : 0.3) + 0.5 * overlap, 0, 1), 2);
}

function pickBest(results: MarketCandidate[], signal: UniverseSignal): MarketCandidate | undefined {
  const needle = signal.match?.toLowerCase();
  return (needle && results.find((m) => m.question.toLowerCase().includes(needle))) || results[0];
}

/** Runs the searches in parallel and merges them into one de-duplicated candidate list. */
async function gatherCandidates(
  queries: string[],
  signals: UniverseSignal[],
  search: SearchMarkets,
  abort?: AbortSignal,
): Promise<{ candidates: MarketCandidate[]; foundBy: Map<string, string> }> {
  const freeText = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  const signalJobs = signals.slice(0, Math.max(0, MAX_SEARCHES - Math.min(freeText.length, 5)));
  const textJobs = freeText.slice(0, MAX_SEARCHES - signalJobs.length);

  const [signalResults, textResults] = await Promise.all([
    Promise.all(signalJobs.map((s) => search(s.query, abort).catch(() => []))),
    Promise.all(textJobs.map((q) => search(q, abort).catch(() => []))),
  ]);

  const byId = new Map<string, MarketCandidate>();
  const add = (m: MarketCandidate, linked: Record<string, number> = {}, label?: string) => {
    const existing = byId.get(m.id);
    const linkedBetas = { ...existing?.linkedBetas };
    for (const [symbol, beta] of Object.entries(linked)) {
      if (!STOCK_BY_SYMBOL.has(symbol)) continue;
      if (Math.abs(beta) > Math.abs(linkedBetas[symbol] ?? 0)) linkedBetas[symbol] = beta;
    }
    byId.set(m.id, {
      ...(existing ?? m),
      linkedSymbols: Object.keys(linkedBetas),
      linkedBetas,
      linkedLabel: existing?.linkedLabel ?? label,
    });
  };
  // Signal markets first: they are the ones the weighting backend can act on.
  signalResults.forEach((results, i) => {
    const best = pickBest(results, signalJobs[i]);
    if (best) add(best, signalJobs[i].betas, signalJobs[i].label);
  });
  // Then round-robin over the free-text queries so each one is represented.
  const longest = Math.max(0, ...textResults.map((r) => r.length));
  const foundBy = new Map<string, string>();
  for (let rank = 0; rank < longest; rank++) {
    textResults.forEach((results, i) => {
      const market = results[rank];
      if (!market) return;
      add(market);
      if (!foundBy.has(market.id)) foundBy.set(market.id, textJobs[i]);
    });
  }
  return { candidates: [...byId.values()], foundBy };
}

/** "+1.2 pts": the way odds moves are written for the decider. */
export function formatPoints(change: number): string {
  const pts = round(change * 100, 1);
  return `${pts > 0 ? "+" : ""}${pts.toFixed(1)} pts`;
}

/** The mock's reading of one market: each linked ticker moves with its sensitivity times the 7-day odds move. */
function mockAnalysis(
  market: MarketCandidate,
  change7d: number | null,
  focus: Set<string>,
): MarketAnalysis {
  const move = change7d ?? 0;
  const tickers = Object.entries(market.linkedBetas ?? {}).map(([symbol, beta]) => ({
    symbol,
    // A 10-point move at sensitivity 1 is the full scale.
    impact: round(clamp(beta * move * 10), 2),
    why: `${STOCK_BY_SYMBOL.get(symbol)!.name} ${beta > 0 ? "gains" : "loses"} if "${market.linkedLabel ?? market.question}" gets more likely.`,
  }));
  const inFocus = tickers.filter((t) => focus.has(t.symbol));
  const pool = inFocus.length ? inFocus : tickers;
  const mean = pool.length ? pool.reduce((sum, t) => sum + t.impact, 0) / pool.length : 0;
  const moved = change7d === null ? "" : `, ${formatPoints(change7d)} over 7 days`;
  return {
    signal: mean > 0.02 ? "bullish" : mean < -0.02 ? "bearish" : "neutral",
    analystNote:
      `Yes is at ${formatOdds(market.probability)}%${moved}. ` +
      (tickers.length
        ? `The weighting universe links it to ${tickers.length} tickers.`
        : "Found by text search; no ticker link."),
    tickers,
  };
}

export function createMockAnalyst(deps: MockAnalystDeps): Analyst {
  return async function mockAnalyst(idea, abort) {
    const now = deps.now?.() ?? new Date();
    // One LLM call plans the search; without it (budget used up, timeout, error) keywords do.
    const plan = (await deps.plan?.(idea, abort).catch(() => null)) ?? null;
    const sectors = plan ? plan.sectors : matchSectors(idea);
    const queries = plan ? plan.queries : [idea.slice(0, 80), ...keywordHits(idea)];
    const warnings = [
      plan
        ? `Mock analyst: search planned by ${plan.model ?? "Gemini"} (${queries.join("; ")}), fixed market-to-ticker links, no analysis.`
        : "Mock analyst: keyword search and fixed market-to-ticker links, no analysis.",
    ];
    if (!sectors.length) warnings.push("The idea does not map to any supported sector.");
    const focus = new Set(STOCKS.filter((s) => sectors.includes(s.sectorId)).map((s) => s.symbol));

    const { candidates, foundBy } = await gatherCandidates(
      queries,
      signalsForSectors(sectors),
      deps.search,
      abort,
    );
    const ranked = candidates
      // Without a supported sector no market can matter for the stocks we cover: none passes the gate.
      .map((m) => {
        const score = relevance(idea, m, plan ? foundBy.get(m.id) : undefined);
        return { m, relevance: sectors.length ? score : Math.min(score, 0.3) };
      })
      .sort((a, b) => b.relevance - a.relevance)
      .slice(0, MAX_MARKETS);
    const ids = ranked.map((r) => r.m.id);

    // Both lookups are optional extras: a slow or failing database never blocks the packet.
    const quick = <T>(work: Promise<T> | undefined, empty: T) =>
      Promise.race([
        (work ?? Promise.resolve(empty)).catch(() => empty),
        new Promise<T>((resolve) => setTimeout(() => resolve(empty), 2000)),
      ]);
    const [past, analyses] = await Promise.all([
      quick(deps.pastOdds?.(ids, now), new Map() as PastOdds),
      quick(deps.analyses?.(ids), new Map<string, MarketAnalysis>()),
    ]);
    if (deps.analyses) {
      warnings.push(
        `${analyses.size} of ${ids.length} markets carry the analyst's notes from Tiger.`,
      );
    }

    const perTicker = new Map<
      string,
      { impact: number; marketIds: string[]; why: string; top: number }
    >();
    const markets = ranked.map(({ m, relevance }) => {
      const before = past.get(m.id);
      const since = (then: number | null | undefined, reported: number | null | undefined) =>
        then === null || then === undefined
          ? (reported ?? null)
          : round(clamp(m.probability - then), 4);
      const change24h = since(before?.d1, m.change24h);
      const change7d = since(before?.d7, m.change7d);
      const analysis = analyses.get(m.id) ?? mockAnalysis(m, change7d, focus);
      for (const t of analysis.tickers) {
        const entry = perTicker.get(t.symbol) ?? { impact: 0, marketIds: [], why: t.why, top: -1 };
        entry.impact += t.impact;
        // The market with the largest impact goes first, and `why` is about that one.
        if (Math.abs(t.impact) > entry.top) {
          entry.top = Math.abs(t.impact);
          entry.why = t.why;
          entry.marketIds.unshift(m.id);
        } else {
          entry.marketIds.push(m.id);
        }
        perTicker.set(t.symbol, entry);
      }
      return {
        id: m.id,
        question: m.question,
        url: m.url,
        probability: m.probability,
        change24h,
        change7d,
        volume24h: m.volume24h ?? null,
        liquidity: m.liquidity ?? null,
        endDate: m.endDate,
        relevance,
        signal: analysis.signal,
        analystNote: analysis.analystNote,
      };
    });

    // Tickers in the idea's sectors first, then by the size of the impact.
    const tickerSignals = [...perTicker.entries()]
      .map(([symbol, t]) => ({
        symbol,
        impact: round(clamp(t.impact), 2),
        marketIds: t.marketIds,
        why: t.why,
      }))
      .sort(
        (a, b) =>
          Number(focus.has(b.symbol)) - Number(focus.has(a.symbol)) ||
          Math.abs(b.impact) - Math.abs(a.impact),
      );

    const themes = SECTORS.filter((s) => sectors.includes(s.id)).flatMap((sector) => {
      const own = tickerSignals.filter((t) => sector.holdings.some((h) => h.symbol === t.symbol));
      const marketIds = [...new Set(own.flatMap((t) => t.marketIds))];
      if (!marketIds.length) return [];
      const mean = own.reduce((sum, t) => sum + t.impact, 0) / own.length;
      const direction: Signal = mean > 0.02 ? "bullish" : mean < -0.02 ? "bearish" : "neutral";
      return [
        {
          name: sector.name,
          direction,
          confidence: round(Math.min(0.9, 0.3 + 0.15 * marketIds.length), 2),
          marketIds,
        },
      ];
    });

    const packet: EvidencePacket = {
      idea,
      generatedAt: now.toISOString(),
      markets,
      themes,
      tickerSignals,
      warnings,
    };
    return packet;
  };
}
