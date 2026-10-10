// HTTP layer for findStocks, shared by POST /api/stocks and its alias POST /api/findstock.
import { corsHeaders, preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
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

// Judges may share one venue IP, so the per-IP limit is generous; the global daily cap is
// what protects the free Gemini quota (each uncached request makes two Gemini calls).
export const PER_IP_PER_MINUTE = 20;
export const PER_IP_PER_DAY = 300;
export const GLOBAL_PER_DAY = 1500;

const CACHE_TTL_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; value: FindStocksResponse }>();

export type HandlerDeps = FindStocksDeps & {
  /** Stores the odds observed for the candidate markets (odds history). */
  record?: (candidates: MarketCandidate[]) => Promise<unknown>;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
};

const defaultDeps: HandlerDeps = {
  generate: geminiGenerateJson,
  search: searchMarkets,
  rateLimit: hit,
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

function json(request: Request, status: number, body: unknown, extra: Record<string, string> = {}) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(request),
      // Explicit charset: Windows PowerShell otherwise misreads non-ASCII characters.
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extra,
    },
  });
}

function error(
  request: Request,
  status: number,
  code: string,
  message: string,
  extra: Record<string, string> = {},
) {
  return json(request, status, { error: { code, message } }, extra);
}

export function createStocksHandler(deps: HandlerDeps = defaultDeps) {
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
    const rate = await deps.rateLimit([
      { bucket: `findstocks:ip:${ip}`, windowSeconds: 60, max: PER_IP_PER_MINUTE },
      { bucket: `findstocks:ipday:${ip}`, windowSeconds: 86_400, max: PER_IP_PER_DAY },
      { bucket: "findstocks:global", windowSeconds: 86_400, max: GLOBAL_PER_DAY },
    ]);
    if (!rate.allowed) {
      return error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
        "Retry-After": String(rate.retryAfterSeconds),
      });
    }

    const key = idea.toLocaleLowerCase().replace(/\s+/g, " ");
    const cached = cache.get(key);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) return json(request, 200, cached.value);

    try {
      // Odds are recorded while Gemini works, so the answer is not delayed.
      let recording: Promise<unknown> | undefined;
      const result = await findStocks(
        {
          idea,
        },
        {
          ...deps,
          onCandidates: (candidates) => {
            recording = deps.record?.(candidates).catch(() => {});
          },
        },
        request.signal,
      );
      await recording;
      // Only AI answers are cached, so a fallback never sticks once Gemini is back.
      if (result.source === "gemini") {
        if (cache.size > 300) cache.clear();
        cache.set(key, { at: Date.now(), value: result });
      }
      return json(request, 200, result);
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
