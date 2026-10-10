// HTTP layer of the decision workflow:
//   POST /api/stocks (alias /api/findstock)  idea → analyst → gate → decider → checker
//   POST /api/analyze                        idea → the analyst's evidence packet
//   POST /api/decide                         idea + packet → gate → decider → checker
import type { MockAnalystDeps } from "../analyst/mock";
import { evidencePacketSchema, type Analyst, type EvidencePacket } from "../analyst/packet";
import {
  cacheHeaders,
  decideCacheKey,
  stocksCacheKey,
  tigerApiCache,
  type ApiCache,
} from "../cache/apiCache";
import { env } from "../env";
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { error, json } from "../http/respond";
import { tigerPastOdds } from "../odds/repo";
import { recordObservations } from "../odds/service";
import { searchMarkets, type SearchMarkets } from "../polymarket/search";
import { geminiGenerateJson, type GenerateJson } from "../sponsors/gemini";
import {
  NoMatchError,
  requestSchema,
  type FindStocksResponse,
  type TraceStep,
} from "../stocks/contract";
import { gate } from "./gate";
import {
  analystMode,
  decideFromPacket,
  defaultAnalysts,
  runAnalyst,
  runPipeline,
  type AnalystMode,
  type PipelineDeps,
  type PipelineResult,
} from "./run";

// Judges may share one venue IP, so the per-IP limit is generous. The global daily cap
// protects the free Gemini quota and only counts requests that actually reach Gemini;
// cached answers are free.
export const PER_IP_PER_MINUTE = 30;
export const PER_IP_PER_DAY = 600;
export const GLOBAL_UNCACHED_PER_DAY = 600;
/**
 * Uncached requests per minute that may call Gemini, across all servers. Each makes at most 2
 * calls, so the worst case is 16 a minute against a measured free quota of 5 (main) + 15 (lite).
 * Requests beyond this get the evidence-only answer.
 */
export const DECIDER_PER_MINUTE = 8;
const MAX_BODY_BYTES = 64 * 1024;

export type HandlerDeps = {
  generate: GenerateJson;
  search: SearchMarkets;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  /** Shared response cache; omitted in tests that do not exercise caching. */
  cache?: ApiCache;
  /** Stores the odds of the packet's markets (odds history). */
  record?: (packet: EvidencePacket) => Promise<unknown>;
  /** Odds 24 hours and 7 days ago, for the mock analyst. */
  pastOdds?: MockAnalystDeps["pastOdds"];
  /** These three default to ANALYST_MODE, the built-in analysts and CHECKER_LLM. */
  mode?: AnalystMode;
  analysts?: Partial<Record<AnalystMode, Analyst>>;
  checkerLlm?: boolean;
  now?: () => Date;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

export const defaultStocksDeps: HandlerDeps = {
  generate: geminiGenerateJson,
  search: searchMarkets,
  rateLimit: hit,
  cache: tigerApiCache,
  pastOdds: tigerPastOdds,
  record: (packet) =>
    recordObservations(
      packet.markets.map((m) => ({
        id: m.id,
        question: m.question,
        url: m.url,
        endDate: m.endDate,
        probability: m.probability,
      })),
      "stocks",
    ),
  log: (event, detail) => console.log(JSON.stringify({ at: "pipeline", event, ...detail })),
};

function pipelineDeps(deps: HandlerDeps): PipelineDeps {
  const mock = { search: deps.search, pastOdds: deps.pastOdds, now: deps.now };
  return {
    generate: deps.generate,
    analysts: { ...defaultAnalysts(mock), ...deps.analysts },
    mode: deps.mode ?? analystMode(),
    checkerLlm: deps.checkerLlm ?? env().CHECKER_LLM,
    deciderBudget: async () =>
      (
        await deps.rateLimit([
          { bucket: "decider:minute", windowSeconds: 60, max: DECIDER_PER_MINUTE },
        ])
      ).allowed,
    now: deps.now,
    log: deps.log,
  };
}

export class NotEnoughEvidenceError extends Error {
  constructor(
    message: string,
    readonly trace: TraceStep[],
  ) {
    super(message);
  }
}

function unwrap(result: PipelineResult, deps: HandlerDeps): FindStocksResponse {
  if (!result.ok) {
    deps.log?.("not_enough_evidence", {
      trace: result.trace.map((t) => `${t.step}: ${t.summary}`),
    });
    throw new NotEnoughEvidenceError(result.message, result.trace);
  }
  deps.log?.("answered", {
    source: result.response.source,
    geminiCalls: result.geminiCalls,
    trace: result.response.trace?.map((t) => `${t.step}: ${t.summary} (${t.ms} ms)`),
  });
  return result.response;
}

/** Runs the workflow without reading the cache, recording the observed odds on the way. */
export async function computeStocks(
  idea: string,
  deps: HandlerDeps,
  signal?: AbortSignal,
): Promise<FindStocksResponse> {
  // Odds are recorded while Gemini works, so the answer is not delayed.
  let recording: Promise<unknown> | undefined;
  const result = await runPipeline(
    idea,
    {
      ...pipelineDeps(deps),
      onPacket: (packet) => {
        recording = deps.record?.(packet).catch(() => {});
      },
    },
    signal,
  );
  await recording;
  return unwrap(result, deps);
}

// ---------- Shared HTTP pieces ----------

const tooMany = (request: Request, rate: RateResult) =>
  error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
    "Retry-After": String(rate.retryAfterSeconds),
  });

async function readBody(request: Request): Promise<{ body: unknown } | { failed: string }> {
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return { failed: "The request body is too large." };
    return { body: JSON.parse(raw) };
  } catch {
    return { failed: "The request body must be JSON." };
  }
}

function perIpLimit(request: Request, deps: HandlerDeps, name: string) {
  const ip = ipKey(clientIp(request));
  return deps.rateLimit([
    { bucket: `${name}:ip:${ip}`, windowSeconds: 60, max: PER_IP_PER_MINUTE },
    { bucket: `${name}:ipday:${ip}`, windowSeconds: 86_400, max: PER_IP_PER_DAY },
  ]);
}

/** Cache lookup, global Gemini cap, the computation, and the error mapping shared by /stocks and /decide. */
async function answer(
  request: Request,
  deps: HandlerDeps,
  cache: { kind: "stocks" | "decide"; key: string },
  compute: () => Promise<FindStocksResponse>,
): Promise<Response> {
  const hitEntry = await deps.cache?.get<FindStocksResponse>(cache.kind, cache.key);
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
    const result = await compute();
    // Only AI answers are cached, so a fallback never sticks once Gemini is back.
    if (result.source === "gemini") await deps.cache?.set(cache.kind, cache.key, result);
    return json(request, 200, { ...result, cached: false, cachedAt: null }, cacheHeaders(null));
  } catch (err) {
    if (err instanceof NotEnoughEvidenceError) {
      return json(request, 422, {
        error: { code: "not_enough_evidence", message: err.message },
        trace: err.trace,
      });
    }
    if (err instanceof NoMatchError) {
      return error(
        request,
        502,
        "no_match",
        "The AI decider is unavailable and the evidence alone does not single out enough supported stocks.",
      );
    }
    deps.log?.("error", { message: err instanceof Error ? err.message.slice(0, 200) : "unknown" });
    return error(request, 502, "upstream_error", "The stock service failed. Please try again.");
  }
}

const OPTIONS = (request: Request): Response => preflight(request);

// ---------- POST /api/stocks ----------

export function createStocksHandler(deps: HandlerDeps = defaultStocksDeps) {
  async function POST(request: Request): Promise<Response> {
    const read = await readBody(request);
    const parsed = requestSchema.safeParse("body" in read ? read.body : undefined);
    if ("failed" in read || !parsed.success) {
      const message =
        "failed" in read
          ? `${read.failed} Expected { "idea": string }.`
          : (parsed.error?.issues[0]?.message ?? "Invalid request.");
      return error(request, 400, "invalid_request", message);
    }
    const { idea } = parsed.data;

    const perIp = await perIpLimit(request, deps, "findstocks");
    if (!perIp.allowed) return tooMany(request, perIp);

    return answer(request, deps, { kind: "stocks", key: stocksCacheKey(idea) }, () =>
      computeStocks(idea, deps, request.signal),
    );
  }
  return { POST, OPTIONS };
}

// ---------- POST /api/analyze ----------

export function createAnalyzeHandler(deps: HandlerDeps = defaultStocksDeps) {
  async function POST(request: Request): Promise<Response> {
    const read = await readBody(request);
    const parsed = requestSchema.safeParse("body" in read ? read.body : undefined);
    if ("failed" in read || !parsed.success) {
      const message =
        "failed" in read
          ? `${read.failed} Expected { "idea": string }.`
          : (parsed.error?.issues[0]?.message ?? "Invalid request.");
      return error(request, 400, "invalid_request", message);
    }
    const perIp = await perIpLimit(request, deps, "analyze");
    if (!perIp.allowed) return tooMany(request, perIp);

    try {
      const { packet, step } = await runAnalyst(
        parsed.data.idea,
        pipelineDeps(deps),
        request.signal,
      );
      await deps.record?.(packet).catch(() => {});
      const started = Date.now();
      const gated = gate(packet, deps.now?.() ?? new Date());
      const trace: TraceStep[] = [
        step,
        {
          step: "gate",
          status: gated.ok ? "ok" : "failed",
          ms: Date.now() - started,
          summary: gated.summary,
        },
      ];
      // The full packet is returned, including markets the gate would not use.
      return json(request, 200, {
        packet,
        gate: { passed: gated.ok, summary: gated.summary },
        trace,
      });
    } catch (err) {
      deps.log?.("error", {
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      });
      return error(request, 502, "upstream_error", "The analyst failed. Please try again.");
    }
  }
  return { POST, OPTIONS };
}

// ---------- POST /api/decide ----------

const decideSchema = requestSchema.extend({ packet: evidencePacketSchema });

export function createDecideHandler(deps: HandlerDeps = defaultStocksDeps) {
  async function POST(request: Request): Promise<Response> {
    const read = await readBody(request);
    const parsed = decideSchema.safeParse("body" in read ? read.body : undefined);
    if ("failed" in read || !parsed.success) {
      const issue = parsed.error?.issues[0];
      const message =
        "failed" in read
          ? `${read.failed} Expected { "idea": string, "packet": EvidencePacket }.`
          : issue
            ? `${issue.path.join(".") || "body"}: ${issue.message}`
            : "Invalid request.";
      return error(request, 400, "invalid_request", message);
    }
    const { idea, packet } = parsed.data;

    const perIp = await perIpLimit(request, deps, "decide");
    if (!perIp.allowed) return tooMany(request, perIp);

    return answer(request, deps, { kind: "decide", key: decideCacheKey(idea, packet) }, async () =>
      unwrap(await decideFromPacket(idea, packet, pipelineDeps(deps), request.signal), deps),
    );
  }
  return { POST, OPTIONS };
}
