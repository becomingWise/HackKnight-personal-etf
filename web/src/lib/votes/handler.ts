// POST /api/votes: five AI voters on the basket /api/stocks returned. Contract: docs/API.md
// section 1d. It does not touch findStocks; it only reads a basket and comments on it.
// A panel is kept with the Polymarket odds it was given: it is reused while none of those markets
// has moved 3 points (for up to 24 hours), and every answer is counted for GET /api/savings.
import { createHash } from "node:crypto";
import { z } from "zod";
import { oddsOf, reuseCached, usableSignals } from "../agent-core/agent/signals.js";
import {
  cacheHeaders,
  normalizeIdea,
  oddsMovedHeader,
  tigerApiCache,
  type ApiCache,
} from "../cache/apiCache";
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { error, json } from "../http/respond";
import { aiBuckets } from "../pipeline/budget";
import { tigerSavings, type SavingsStore } from "../savings/store";
import { geminiGenerateJson, type GenerateJson } from "../sponsors/gemini";
import { STOCK_BY_SYMBOL } from "../stocks/universe";
import { adjustWeights } from "../weights/adjustWeights";
import type { Signal } from "../weights/engine";
import { liveSignals } from "../weights/signals";
import { VOTERS, runPanel, type Evidence, type VotesResponse } from "./votes";

export const VOTES_CACHE_SECONDS = 30 * 60;
/** A panel that was given Polymarket odds is kept this long, while those odds hold still. */
export const VOTES_ODDS_CACHE_SECONDS = 24 * 60 * 60;
const PER_IP_PER_MINUTE = 20;
const PER_IP_PER_DAY = 300;
const MAX_BODY_BYTES = 16 * 1024;

const requestSchema = z.object({
  idea: z.string().trim().min(1, "idea must be a non-empty string").max(500),
  stocks: z
    .array(z.object({ symbol: z.string().trim().min(1).max(20), name: z.string().trim().max(120) }))
    .min(1, "stocks must list at least one stock")
    .max(5, "stocks may list at most 5 stocks"),
});

export type VotesDeps = {
  generate: GenerateJson;
  signals: () => Promise<Signal[]>;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  cache?: ApiCache;
  /** Counts the served answer for GET /api/savings. */
  count?: SavingsStore["record"];
  now?: () => Date;
  log?: (detail: Record<string, unknown>) => void;
};

export const defaultVotesDeps: VotesDeps = {
  generate: geminiGenerateJson,
  signals: liveSignals,
  rateLimit: hit,
  cache: tigerApiCache,
  count: tigerSavings.record,
  log: (detail) => console.log(JSON.stringify({ at: "votes", ...detail })),
};

/** One entry per (idea, set of symbols); the order of the stocks does not matter. */
export const votesCacheKey = (idea: string, symbols: string[]) =>
  createHash("sha256")
    .update(`votes:v2:${normalizeIdea(idea)}:${[...symbols].sort().join(",")}`)
    .digest("hex");

/** What is cached: the panel, the odds of the markets it was given, and when it voted. */
type CachedPanel = { response: VotesResponse; odds?: Record<string, number>; at: number };

/** Hao's Polymarket evidence for these stocks: the same computation as POST /api/weights. */
function polymarketEvidence(
  idea: string,
  symbols: string[],
  signals: Signal[],
  now: Date,
): Evidence[] {
  try {
    const cents = Math.floor(10000 / symbols.length);
    const holdings = symbols.map((symbol, i) => ({
      symbol,
      weightPct: (i === symbols.length - 1 ? 10000 - cents * i : cents) / 100,
    }));
    return adjustWeights({ idea, holdings }, signals, now).evidence;
  } catch {
    // The macro voter is then told that no market is linked.
    return [];
  }
}

export function createVotesHandler(deps: VotesDeps = defaultVotesDeps) {
  async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) throw new Error("too large");
      body = JSON.parse(raw);
    } catch {
      return error(
        request,
        400,
        "invalid_request",
        'The request body must be JSON: { "idea": string, "stocks": [{ "symbol", "name" }] }.',
      );
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return error(
        request,
        400,
        "invalid_request",
        `${where}${issue?.message ?? "Invalid request."}`,
      );
    }
    const { idea } = parsed.data;
    const symbols = parsed.data.stocks.map((s) => s.symbol.toUpperCase());
    if (new Set(symbols).size !== symbols.length) {
      return error(request, 400, "invalid_request", "stocks has duplicate symbols.");
    }
    const unknown = symbols.filter((symbol) => !STOCK_BY_SYMBOL.has(symbol));
    if (unknown.length) {
      return error(
        request,
        400,
        "invalid_request",
        `Not a stock /api/stocks can return: ${unknown.join(", ")}.`,
      );
    }
    // Names come from our own list, so the voters never see text a caller made up.
    const stocks = symbols.map((symbol) => ({ symbol, name: STOCK_BY_SYMBOL.get(symbol)!.name }));

    const ip = ipKey(clientIp(request));
    const perIp = await deps.rateLimit([
      { bucket: `votes:ip:${ip}`, windowSeconds: 60, max: PER_IP_PER_MINUTE },
      { bucket: `votes:ipday:${ip}`, windowSeconds: 86_400, max: PER_IP_PER_DAY },
    ]);
    if (!perIp.allowed) {
      return error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
        "Retry-After": String(perIp.retryAfterSeconds),
      });
    }

    const key = votesCacheKey(idea, symbols);
    const inRequestOrder = (value: VotesResponse): VotesResponse => ({
      ...value,
      stocks: symbols.map((symbol) => value.stocks.find((s) => s.symbol === symbol)!),
    });
    const now = deps.now?.() ?? new Date();
    // Read before the cache: the live odds decide whether a cached panel may be served again.
    const signals = await deps.signals().catch((): Signal[] => []);
    const live = usableSignals(signals);
    const cached = await deps.cache?.get<CachedPanel>("votes", key);
    let movedSince: number | null = null;
    if (cached) {
      const { reuse, moved } = reuseCached(cached.value, live, now.getTime(), {
        plainTtlMs: VOTES_CACHE_SECONDS * 1000,
        citedTtlMs: VOTES_ODDS_CACHE_SECONDS * 1000,
      });
      if (reuse) {
        await deps.count?.("votes", true, now).catch(() => {});
        return json(request, 200, inRequestOrder(cached.value.response), {
          ...cacheHeaders(cached, now.getTime()),
          ...oddsMovedHeader(moved),
        });
      }
      movedSince = moved;
    }

    // The panel is five Gemini calls: it counts twice against the shared caps for AI requests
    // (each unit stands for up to three calls). The minute and visitor caps go first.
    const [minute, session, day, visitor] = aiBuckets(ip);
    for (const limits of [
      [minute, visitor],
      [session, day],
      [minute, visitor],
      [session, day],
    ]) {
      const allowed = await deps.rateLimit(limits);
      if (!allowed.allowed) {
        return error(
          request,
          503,
          "ai_budget_used_up",
          "The AI panel is resting to stay within its free quota. Please try again in a few minutes.",
          { "Retry-After": String(Math.max(60, allowed.retryAfterSeconds)) },
        );
      }
    }

    const evidence = polymarketEvidence(idea, symbols, signals, now);
    const panel = await runPanel({ idea, stocks, evidence }, deps, request.signal);
    deps.log?.({ event: "voted", complete: panel.complete, silent: panel.silent });
    if (panel.silent === VOTERS.length) {
      return error(
        request,
        503,
        "votes_unavailable",
        "None of the AI voters answered. Please try again in a minute.",
      );
    }
    // Only a full panel is kept, so a voter that was briefly unavailable gets another chance.
    if (panel.complete === VOTERS.length) {
      // The markets linked to these stocks are the ones the macro voter was shown.
      const linked = live.filter((s) => symbols.some((symbol) => symbol in s.betas));
      const odds = oddsOf(
        linked.map((s) => s.id),
        live,
      );
      const cited = Object.keys(odds).length > 0;
      const entry: CachedPanel = {
        response: panel.response,
        ...(cited ? { odds } : {}),
        at: now.getTime(),
      };
      await deps.cache?.set(
        "votes",
        key,
        entry,
        cited ? VOTES_ODDS_CACHE_SECONDS : VOTES_CACHE_SECONDS,
      );
    }
    await deps.count?.("votes", false, now).catch(() => {});
    return json(request, 200, panel.response, {
      ...cacheHeaders(null),
      ...oddsMovedHeader(movedSince),
    });
  }
  return { POST, OPTIONS: (request: Request): Response => preflight(request) };
}
