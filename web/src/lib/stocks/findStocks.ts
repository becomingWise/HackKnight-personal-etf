// findStocks: idea → 3–5 stocks from the weighting universe, each reason backed by a live
// Polymarket market. Contract: docs/API.md section 1 (the team's "Stock selection port").
import { z } from "zod";
import type { MarketCandidate, SearchMarkets } from "../polymarket/search";
import { ThinkingLevel, type GenerateJson } from "../sponsors/gemini";
import {
  SECTORS,
  SECTOR_IDS,
  STOCKS,
  STOCK_BY_SYMBOL,
  SYMBOLS,
  matchSectors,
  signalsForSectors,
  type UniverseSignal,
} from "./universe";

export const MIN_STOCKS = 3;
export const MAX_STOCKS = 5;
export const MAX_IDEA_LENGTH = 500;
const MAX_CANDIDATES = 30;
const MAX_SEARCHES = 10;
/** Total time Gemini may use before the keyword fallback takes over. */
const GEMINI_BUDGET_MS = 20_000;

// ---------- Contract ----------

export const requestSchema = z.object({
  idea: z
    .string({ error: "idea must be a string" })
    .trim()
    .min(1, "idea must be a non-empty string")
    .max(MAX_IDEA_LENGTH, `idea must be at most ${MAX_IDEA_LENGTH} characters`),
});

const nonEmpty = z.string().refine((s) => s.trim().length > 0, "must be non-empty");

/** The response shape in docs/API.md. `summary` and `stocks[].{symbol,name,reason}` are the contract; the rest is optional extra. */
export const responseSchema = z.object({
  summary: z.string(),
  stocks: z
    .array(
      z.object({
        symbol: nonEmpty,
        name: nonEmpty,
        reason: nonEmpty,
        marketId: z.string().nullable(),
      }),
    )
    .min(MIN_STOCKS)
    .max(MAX_STOCKS),
  source: z.enum(["gemini", "fallback"]),
  markets: z.array(
    z.object({
      id: z.string(),
      title: nonEmpty,
      url: z.url(),
      outcome: z.literal("Yes"),
      probability: z.number().min(0).max(1),
      observedAt: z.iso.datetime(),
    }),
  ),
});

export type FindStocksResponse = z.infer<typeof responseSchema>;

export class NoMatchError extends Error {
  constructor() {
    super("No stocks in the supported universe match this idea.");
  }
}

// ---------- Gemini shapes ----------

const planSchema = z.object({
  queries: z.array(z.string().trim().min(2).max(80)).min(1).max(5),
  sectors: z.array(z.enum(SECTOR_IDS as [string, ...string[]])).max(4),
});

const pickSchema = z.object({
  summary: z.string().trim().min(10).max(700),
  stocks: z
    .array(
      z.object({
        symbol: z.enum(SYMBOLS as [string, ...string[]]),
        market_id: z.string().nullable(),
        reason: z.string().trim().min(10).max(450),
        link: z.string().trim().min(5).max(300),
      }),
    )
    .min(1)
    .max(8),
});

const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    queries: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    sectors: { type: "array", items: { type: "string", enum: SECTOR_IDS }, maxItems: 4 },
  },
  required: ["queries", "sectors"],
};

const PICK_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    stocks: {
      type: "array",
      minItems: MIN_STOCKS,
      maxItems: MAX_STOCKS,
      items: {
        type: "object",
        properties: {
          symbol: { type: "string", enum: SYMBOLS },
          market_id: { type: ["string", "null"] },
          reason: { type: "string" },
          link: { type: "string" },
        },
        required: ["symbol", "market_id", "reason", "link"],
      },
    },
  },
  required: ["summary", "stocks"],
};

// ---------- Helpers ----------

/** 0.075 → "7.5", 0.72 → "72": the way odds are quoted in reasons. */
export function formatOdds(probability: number): string {
  const pct = probability * 100;
  if (pct < 10 || pct > 90) return String(Math.round(pct * 10) / 10);
  return String(Math.round(pct));
}

/** True when every percentage in the text is within 1 point of an allowed market's Yes or No odds. */
export function oddsAreAccurate(text: string, markets: MarketCandidate[]): boolean {
  const quoted = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*[%％]/g)].map((m) =>
    Number(m[1].replace(",", ".")),
  );
  return quoted.every((value) =>
    markets.some((m) => {
      const yes = m.probability * 100;
      return Math.abs(value - yes) <= 1 || Math.abs(value - (100 - yes)) <= 1;
    }),
  );
}

function composedReason(market: MarketCandidate, link: string): string {
  return `Polymarket gives ${formatOdds(market.probability)}% to "${market.question}": ${link}`;
}

function stockList(): string {
  return SECTORS.map(
    (s) => `${s.name} [${s.id}]: ${s.holdings.map((h) => `${h.symbol} (${h.name})`).join(", ")}`,
  ).join("\n");
}

function marketLine(m: MarketCandidate): string {
  const change =
    m.change7d === null
      ? ""
      : `, 7-day change ${m.change7d >= 0 ? "+" : ""}${(m.change7d * 100).toFixed(1)} pts`;
  const ends = m.endDate ? `, ends ${m.endDate.slice(0, 10)}` : "";
  const linked = m.linkedSymbols.length ? `; linked tickers: ${m.linkedSymbols.join(", ")}` : "";
  return `- id ${m.id}: "${m.question}" — Yes ${formatOdds(m.probability)}%${change}${ends}${linked}`;
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
): Promise<MarketCandidate[]> {
  const freeText = [...new Set(queries.map((q) => q.trim()).filter(Boolean))];
  const signalJobs = signals.slice(0, Math.max(0, MAX_SEARCHES - Math.min(freeText.length, 5)));
  const textJobs = freeText.slice(0, MAX_SEARCHES - signalJobs.length);

  const [signalResults, textResults] = await Promise.all([
    Promise.all(signalJobs.map((s) => search(s.query, abort).catch(() => []))),
    Promise.all(textJobs.map((q) => search(q, abort).catch(() => []))),
  ]);

  const byId = new Map<string, MarketCandidate>();
  const add = (m: MarketCandidate, linked: Record<string, number> = {}) => {
    const existing = byId.get(m.id);
    const linkedBetas = { ...existing?.linkedBetas };
    for (const [symbol, beta] of Object.entries(linked)) {
      if (!STOCK_BY_SYMBOL.has(symbol)) continue;
      if (Math.abs(beta) > Math.abs(linkedBetas[symbol] ?? 0)) linkedBetas[symbol] = beta;
    }
    byId.set(m.id, { ...(existing ?? m), linkedSymbols: Object.keys(linkedBetas), linkedBetas });
  };
  // Signal markets first: they are the ones the weighting backend can act on.
  signalResults.forEach((results, i) => {
    const best = pickBest(results, signalJobs[i]);
    if (best) add(best, signalJobs[i].betas);
  });
  // Then round-robin over the free-text queries so each one is represented.
  const longest = Math.max(0, ...textResults.map((r) => r.length));
  for (let rank = 0; rank < longest; rank++) {
    for (const results of textResults) if (results[rank]) add(results[rank]);
  }
  return [...byId.values()].slice(0, MAX_CANDIDATES);
}

function evidence(markets: MarketCandidate[], observedAt: string): FindStocksResponse["markets"] {
  return markets.map((m) => ({
    id: m.id,
    title: m.question,
    url: m.url,
    outcome: "Yes" as const,
    probability: m.probability,
    observedAt,
  }));
}

function oddsSentence(markets: MarketCandidate[]): string {
  if (!markets.length) return "";
  const parts = markets.slice(0, 3).map((m) => `"${m.question}" ${formatOdds(m.probability)}%`);
  return ` Key Polymarket odds: ${parts.join("; ")}.`;
}

// ---------- Gemini steps ----------

const PLAN_SYSTEM = `You turn an investing idea into Polymarket search queries.
Return 2 to 5 short English search queries (2 to 5 words each) for prediction markets about real-world events that would move stocks related to the idea: policy, geopolitics, macro, technology milestones, company events.
Also return the sector ids from the given list that fit the idea (none if nothing fits).
The idea may be in any language; queries are always in English.`;

const PICK_SYSTEM = `You are the stock-selection service of a personal-ETF app. You map a user's idea to stocks, using live Polymarket prediction markets as evidence.

Rules:
- Pick ${MIN_STOCKS} to ${MAX_STOCKS} different stocks, ONLY from the allowed list. Prefer stocks whose business is clearly exposed to the idea.
- For each stock, set market_id to the id of the single most relevant market from the candidate list, or null if no candidate is relevant to that stock. Never invent a market or an id.
- "reason": one or two sentences for the user. When market_id is set, cite that market and its current odds exactly as given, for example: Polymarket gives 72% that <event>, which matters for <company> because <link>. When market_id is null, explain the fit without mentioning Polymarket or any percentage.
- "link": the same explanation of why the market matters for the company, as one sentence WITHOUT any numbers.
- "summary": two or three sentences on how the idea maps to these companies and which Polymarket markets matter most. Do not put numbers or percentages in the summary.
- When several candidate markets are relevant, cite different markets for different stocks rather than repeating one.
- Never mention stock prices, price targets, returns, allocation percentages or weights. Never give investment advice.
- Write summary, reason and link in the same language as the user's idea. Keep ticker symbols and market questions as given.`;

async function planQueries(
  idea: string,
  generate: GenerateJson,
  abort?: AbortSignal,
): Promise<z.infer<typeof planSchema> | null> {
  try {
    const raw = await generate({
      system: PLAN_SYSTEM,
      prompt: `Sector ids: ${SECTORS.map((s) => `${s.id} (${s.name})`).join(", ")}\n\nIdea: ${idea}`,
      schema: PLAN_JSON_SCHEMA,
      timeoutMs: 6000,
      thinking: ThinkingLevel.MINIMAL,
      // The lighter model plans queries, leaving the main model's per-minute quota for the pick.
      prefer: "lite",
      signal: abort,
    });
    const parsed = planSchema.safeParse(raw);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

type Picked = { symbol: string; reason: string; market: MarketCandidate | null };

/** Validates Gemini's pick against the candidates. Returns the usable stocks or a problem description. */
function checkPick(
  raw: unknown,
  candidates: Map<string, MarketCandidate>,
): { ok: true; summary: string; stocks: Picked[] } | { ok: false; problem: string } {
  const parsed = pickSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, problem: "The JSON did not follow the schema." };

  const stocks: Picked[] = [];
  const seen = new Set<string>();
  for (const s of parsed.data.stocks) {
    if (seen.has(s.symbol)) continue;
    if (s.market_id === null) {
      // No citation: the reason must not claim Polymarket odds.
      if (/polymarket|[%％]/i.test(s.reason)) continue;
      stocks.push({ symbol: s.symbol, reason: s.reason, market: null });
    } else {
      const market = candidates.get(s.market_id.trim());
      // A market that was not among the candidates is a fabrication: drop the stock.
      if (!market) continue;
      const accurate = /[%％]/.test(s.reason) && oddsAreAccurate(s.reason, [market]);
      stocks.push({
        symbol: s.symbol,
        reason: accurate ? s.reason : composedReason(market, s.link),
        market,
      });
    }
    seen.add(s.symbol);
    if (stocks.length === MAX_STOCKS) break;
  }
  if (stocks.length < MIN_STOCKS) {
    return {
      ok: false,
      problem: `Only ${stocks.length} stocks were usable; cite only market ids from the candidate list and pick ${MIN_STOCKS} to ${MAX_STOCKS} different allowed symbols.`,
    };
  }
  const cited = stocks.flatMap((s) => (s.market ? [s.market] : []));
  if (!oddsAreAccurate(parsed.data.summary, cited)) {
    return { ok: false, problem: "The summary must not contain numbers or percentages." };
  }
  return { ok: true, summary: parsed.data.summary, stocks };
}

// ---------- Fallback ----------

/** Keyword-based selection in the same response shape, used when Gemini fails or times out. */
export function fallbackSelection(
  idea: string,
  candidates: MarketCandidate[],
  observedAt: string,
): FindStocksResponse {
  const sectors = matchSectors(idea);
  // The market a stock is most sensitive to, among the live candidates.
  const linked = (symbol: string) =>
    candidates
      .filter((m) => m.linkedSymbols.includes(symbol))
      .sort(
        (a, b) => Math.abs(b.linkedBetas?.[symbol] ?? 0) - Math.abs(a.linkedBetas?.[symbol] ?? 0),
      )[0] ?? null;

  let symbols: string[];
  if (sectors.length) {
    // Round-robin over the matched sectors, so an idea spanning two themes gets both.
    const lists = sectors.map((id) => STOCKS.filter((s) => s.sectorId === id).map((s) => s.symbol));
    const pool: string[] = [];
    for (let i = 0; i < Math.max(...lists.map((l) => l.length)); i++) {
      for (const list of lists) if (list[i]) pool.push(list[i]);
    }
    // Stocks backed by a live market first, keeping the sector order otherwise.
    symbols = [...pool.filter((s) => linked(s)), ...pool.filter((s) => !linked(s))];
  } else {
    symbols = [...new Set(candidates.flatMap((m) => m.linkedSymbols))];
  }
  symbols = symbols.slice(0, MAX_STOCKS);
  if (symbols.length < MIN_STOCKS) throw new NoMatchError();

  const used: MarketCandidate[] = [];
  const stocks = symbols.map((symbol) => {
    const stock = STOCK_BY_SYMBOL.get(symbol)!;
    const market = linked(symbol);
    if (market && !used.includes(market)) used.push(market);
    return {
      symbol,
      name: stock.name,
      reason: market
        ? composedReason(
            market,
            `${stock.name} is one of the ${stock.sectorName} names linked to this event.`,
          )
        : `${stock.name} is a core ${stock.sectorName} holding that matches your idea by keyword.`,
      marketId: market?.id ?? null,
    };
  });
  const sectorNames = [...new Set(symbols.map((s) => STOCK_BY_SYMBOL.get(s)!.sectorName))];
  return {
    summary:
      `Keyword match (AI ranking was unavailable, so this is a simpler selection): your idea maps to ${sectorNames.join(", ")}.` +
      oddsSentence(used),
    stocks,
    source: "fallback",
    markets: evidence(used, observedAt),
  };
}

// ---------- Pipeline ----------

export type FindStocksDeps = {
  generate: GenerateJson;
  search: SearchMarkets;
  now?: () => Date;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

export async function findStocks(
  input: { idea: string },
  deps: FindStocksDeps,
  abort?: AbortSignal,
): Promise<FindStocksResponse> {
  const { idea } = requestSchema.parse(input);
  const log = deps.log ?? (() => {});
  const started = Date.now();
  const remaining = () => GEMINI_BUDGET_MS - (Date.now() - started);

  // 1. Search queries and sectors: Gemini, or keywords when it is unavailable.
  const plan = await planQueries(idea, deps.generate, abort);
  const sectors = plan?.sectors.length ? plan.sectors : matchSectors(idea);
  const queries = plan?.queries ?? [idea.slice(0, 80)];

  // 2. Candidate markets: live, unresolved, with a real price.
  const candidates = await gatherCandidates(
    queries,
    signalsForSectors(sectors),
    deps.search,
    abort,
  );
  const byId = new Map(candidates.map((m) => [m.id, m]));
  const observedAt = (deps.now?.() ?? new Date()).toISOString();
  log("candidates", {
    planned: !!plan,
    queries: queries.length,
    sectors,
    candidates: candidates.length,
  });

  // 3. Gemini picks and explains; one retry on invalid output.
  const prompt =
    `Allowed stocks (symbol and company, by sector):\n${stockList()}\n\n` +
    (candidates.length
      ? `Candidate Polymarket markets (live odds for "Yes"):\n${candidates.map(marketLine).join("\n")}`
      : "Candidate Polymarket markets: none found. Set every market_id to null.") +
    `\n\nUser's idea: ${idea}`;
  let problem = "";
  for (let attempt = 1; attempt <= 2 && remaining() > 3000; attempt++) {
    try {
      const raw = await deps.generate({
        system: PICK_SYSTEM,
        prompt: problem
          ? `${prompt}\n\nYour previous answer was rejected: ${problem} Answer again.`
          : prompt,
        schema: PICK_JSON_SCHEMA,
        timeoutMs: Math.min(12_000, remaining()),
        signal: abort,
      });
      const checked = checkPick(raw, byId);
      if (!checked.ok) {
        problem = checked.problem;
        log("gemini_invalid", { attempt, problem });
        continue;
      }
      const cited = [...new Set(checked.stocks.flatMap((s) => (s.market ? [s.market] : [])))];
      return {
        summary: checked.summary + oddsSentence(cited),
        stocks: checked.stocks.map((s) => ({
          symbol: s.symbol,
          name: STOCK_BY_SYMBOL.get(s.symbol)!.name,
          reason: s.reason,
          marketId: s.market?.id ?? null,
        })),
        source: "gemini",
        markets: evidence(cited, observedAt),
      };
    } catch (err) {
      if (abort?.aborted) throw err;
      problem = "";
      log("gemini_error", {
        attempt,
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      });
    }
  }

  // 4. Fallback: keyword matches in the same shape.
  log("fallback", { elapsed_ms: Date.now() - started });
  return fallbackSelection(idea, candidates, observedAt);
}
