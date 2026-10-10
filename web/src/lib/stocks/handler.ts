// HTTP layer for findStocks, shared by POST /api/stocks and its alias POST /api/findstock.
import { cacheHeaders, stocksCacheKey, tigerApiCache, type ApiCache } from "../cache/apiCache";
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { error, json } from "../http/respond";
import { recordObservations } from "../odds/service";
import { searchMarkets, type MarketCandidate } from "../polymarket/search";
import { geminiGenerateJson } from "../sponsors/gemini";
import {
  NoMatchError,
  findStocks,
  requestSchema,
  type FindStocksDeps,
  type FindStocksResponse,
} from "./findStocks";

// Judges may share one venue IP, so the per-IP limit is generous. The global daily cap
// protects the free Gemini quota and only counts requests that actually reach Gemini
// (each one makes two Gemini calls); cached answers are free.
export const PER_IP_PER_MINUTE = 30;
export const PER_IP_PER_DAY = 600;
export const GLOBAL_UNCACHED_PER_DAY = 600;

export type HandlerDeps = FindStocksDeps & {
  /** Stores the odds observed for the candidate markets (odds history). */
  record?: (candidates: MarketCandidate[]) => Promise<unknown>;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  /** Shared response cache; omitted in tests that do not exercise caching. */
  cache?: ApiCache;
};

export const defaultStocksDeps: HandlerDeps = {
  generate: geminiGenerateJson,
  search: searchMarkets,
  rateLimit: hit,
  cache: tigerApiCache,
  record: (candidates) =>
    recordObservations(
      candidates.map((m) => ({
        id: m.id,
        question: m.question,
        url: m.url,
        yesTokenId: m.yesTokenId,
        endDate: m.endDate,
        probability: m.probability,
      })),
      "stocks",
    ),
  log: (event, detail) => console.log(JSON.stringify({ at: "findStocks", event, ...detail })),
};

/** Runs the pipeline without reading the cache, recording the observed odds on the way. */
export async function computeStocks(
  idea: string,
  deps: HandlerDeps,
  signal?: AbortSignal,
): Promise<FindStocksResponse> {
  // Odds are recorded while Gemini works, so the answer is not delayed.
  let recording: Promise<unknown> | undefined;
  const result = await findStocks(
    { idea },
    {
      ...deps,
      onCandidates: (candidates) => {
        recording = deps.record?.(candidates).catch(() => {});
      },
    },
    signal,
  );
  await recording;
  return result;
}

export function createStocksHandler(deps: HandlerDeps = defaultStocksDeps) {
  const tooMany = (request: Request, rate: RateResult) =>
    error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
      "Retry-After": String(rate.retryAfterSeconds),
    });

  async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return error(
        request,
        400,
        "invalid_request",
        'The request body must be JSON: { "idea": string }.',
      );
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return error(
        request,
        400,
        "invalid_request",
        parsed.error.issues[0]?.message ?? "Invalid request.",
      );
    }
    const { idea } = parsed.data;

    const ip = ipKey(clientIp(request));
    const perIp = await deps.rateLimit([
      { bucket: `findstocks:ip:${ip}`, windowSeconds: 60, max: PER_IP_PER_MINUTE },
      { bucket: `findstocks:ipday:${ip}`, windowSeconds: 86_400, max: PER_IP_PER_DAY },
    ]);
    if (!perIp.allowed) return tooMany(request, perIp);

    const key = stocksCacheKey(idea);
    const hitEntry = await deps.cache?.get<FindStocksResponse>("stocks", key);
    if (hitEntry) {
      return json(
        request,
        200,
        { ...hitEntry.value, cached: true, cachedAt: hitEntry.createdAt.toISOString() },
        cacheHeaders(hitEntry),
      );
    }

    const global = await deps.rateLimit([
      { bucket: "findstocks:uncached", windowSeconds: 86_400, max: GLOBAL_UNCACHED_PER_DAY },
    ]);
    if (!global.allowed) return tooMany(request, global);

    try {
      const result = await computeStocks(idea, deps, request.signal);
      // Only AI answers are cached, so a fallback never sticks once Gemini is back.
      if (result.source === "gemini") await deps.cache?.set("stocks", key, result);
      return json(request, 200, { ...result, cached: false, cachedAt: null }, cacheHeaders(null));
    } catch (err) {
      if (err instanceof NoMatchError) {
        return error(
          request,
          502,
          "no_match",
          "The stock service is unavailable and no supported stocks matched this idea by keyword.",
        );
      }
      deps.log?.("error", {
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      });
      return error(request, 502, "upstream_error", "The stock service failed. Please try again.");
    }
  }

  function OPTIONS(request: Request): Response {
    return preflight(request);
  }

  return { POST, OPTIONS };
}
