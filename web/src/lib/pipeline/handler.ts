// HTTP layer of the decision workflow:
//   POST /api/stocks (alias /api/findstock)  idea → analyst → gate → decider → checker
//   POST /api/analyze                        idea → the analyst's evidence packet
//   POST /api/decide                         idea + packet → gate → decider → checker
import type { SignalsAnalystDeps } from "../analyst/signals";
import { evidencePacketSchema, type Analyst, type EvidencePacket } from "../analyst/packet";
import { createPlanner, type Planner } from "../analyst/plan";
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
  EXAMPLE_IDEAS,
  NoMatchError,
  requestSchema,
  type FindStocksResponse,
  type TraceStep,
} from "../stocks/contract";
import { aiBuckets } from "./budget";
import { gate, type GateResult } from "./gate";
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

// Requests per visitor IP, cached or not. Judges may share one venue IP, so this is generous;
// what protects the Gemini quota is the budget in ./budget.ts, which only uncached requests use.
export const PER_IP_PER_MINUTE = 30;
export const PER_IP_PER_DAY = 600;
const MAX_BODY_BYTES = 64 * 1024;

export type HandlerDeps = {
  generate: GenerateJson;
  search: SearchMarkets;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  /** Shared response cache; omitted in tests that do not exercise caching. */
  cache?: ApiCache;
  /** Stores the odds of the packet's markets (odds history). */
  record?: (packet: EvidencePacket) => Promise<unknown>;
  /** Odds 24 hours and 7 days ago, for the signals analyst. */
  pastOdds?: SignalsAnalystDeps["pastOdds"];
  /** The signals analyst's search planner. Default: one Gemini call, cached. null: keywords only. */
  plan?: Planner | null;
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

/** `ai: false` runs the whole workflow without Gemini: keyword search, evidence-only selection. */
function pipelineDeps(deps: HandlerDeps, ai: boolean): PipelineDeps {
  const plan =
    deps.plan === null || !ai
      ? undefined
      : (deps.plan ?? createPlanner({ generate: deps.generate, cache: deps.cache }));
  const base = { search: deps.search, pastOdds: deps.pastOdds, now: deps.now, plan };
  return {
    generate: deps.generate,
    analysts: { ...defaultAnalysts(base), ...deps.analysts },
    mode: deps.mode ?? analystMode(),
    checkerLlm: deps.checkerLlm ?? env().CHECKER_LLM,
    deciderBudget: async () => ai,
    now: deps.now,
    log: deps.log,
  };
}

/**
 * Counts one uncached request against the Gemini budget. The per-minute and per-visitor counters
 * go first, so a burst that is turned away does not eat into the day's budget.
 */
async function aiAllowed(request: Request, deps: HandlerDeps): Promise<boolean> {
  const [minute, session, day, perIp] = aiBuckets(ipKey(clientIp(request)));
  if (!(await deps.rateLimit([minute, perIp])).allowed) return false;
  return (await deps.rateLimit([session, day])).allowed;
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
  ai = true,
): Promise<FindStocksResponse> {
  // Odds are recorded while Gemini works, so the answer is not delayed.
  let recording: Promise<unknown> | undefined;
  const result = await runPipeline(
    idea,
    {
      ...pipelineDeps(deps, ai),
      onPacket: (packet) => {
        recording = deps.record?.(packet).catch(() => {});
      },
    },
    signal,
  );
  await recording;
  return unwrap(result, deps);
}

/** The analyst's packet for an idea and what the gate makes of it. No decision, so at most the cached search plan's one Gemini call. */
export async function currentEvidence(
  idea: string,
  deps: HandlerDeps,
  signal?: AbortSignal,
  ai = true,
): Promise<{ packet: EvidencePacket; gated: GateResult; trace: TraceStep[] }> {
  const { packet, step } = await runAnalyst(idea, pipelineDeps(deps, ai), signal);
  const started = Date.now();
  const gated = gate(packet, deps.now?.() ?? new Date());
  const gateStep: TraceStep = {
    step: "gate",
    status: gated.ok ? "ok" : "failed",
    ms: Date.now() - started,
    summary: gated.summary,
  };
  return { packet, gated, trace: [step, gateStep] };
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

/** Cache lookup, the Gemini budget, the computation, and the error mapping shared by /stocks and /decide. */
async function answer(
  request: Request,
  deps: HandlerDeps,
  cache: { kind: "stocks" | "decide"; key: string },
  compute: (ai: boolean) => Promise<FindStocksResponse>,
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

  // Over budget is not an error: the request is answered without Gemini.
  const ai = await aiAllowed(request, deps);
  if (!ai) deps.log?.("ai_budget_used_up");

  try {
    const result = await compute(ai);
    // Only AI answers are cached, so a fallback never sticks once Gemini is back.
    if (result.source === "gemini") await deps.cache?.set(cache.kind, cache.key, result);
    return json(request, 200, { ...result, cached: false, cachedAt: null }, cacheHeaders(null));
  } catch (err) {
    if (err instanceof NotEnoughEvidenceError) {
      const examples = [...EXAMPLE_IDEAS];
      return json(request, 422, {
        error: {
          code: "not_enough_evidence",
          message: `${err.message} Ideas that work: ${examples.map((e) => `"${e}"`).join(", ")}.`,
          // The reason alone, and the examples as a list, for a frontend that renders its own text.
          reason: err.message,
          examples,
        },
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

function invalidIdea(request: Request, read: { failed: string } | undefined, issue?: string) {
  const message = read
    ? `${read.failed} Expected { "idea": string }.`
    : (issue ?? "Invalid request.");
  return error(request, 400, "invalid_request", message);
}

// ---------- POST /api/stocks ----------

export function createStocksHandler(deps: HandlerDeps = defaultStocksDeps) {
  async function POST(request: Request): Promise<Response> {
    const read = await readBody(request);
    const parsed = requestSchema.safeParse("body" in read ? read.body : undefined);
    if ("failed" in read) return invalidIdea(request, read);
    if (!parsed.success) return invalidIdea(request, undefined, parsed.error.issues[0]?.message);
    const { idea } = parsed.data;

    const perIp = await perIpLimit(request, deps, "findstocks");
    if (!perIp.allowed) return tooMany(request, perIp);

    return answer(request, deps, { kind: "stocks", key: stocksCacheKey(idea) }, (ai) =>
      computeStocks(idea, deps, request.signal, ai),
    );
  }
  return { POST, OPTIONS };
}

// ---------- POST /api/analyze ----------

export function createAnalyzeHandler(deps: HandlerDeps = defaultStocksDeps) {
  async function POST(request: Request): Promise<Response> {
    const read = await readBody(request);
    const parsed = requestSchema.safeParse("body" in read ? read.body : undefined);
    if ("failed" in read) return invalidIdea(request, read);
    if (!parsed.success) return invalidIdea(request, undefined, parsed.error.issues[0]?.message);
    const perIp = await perIpLimit(request, deps, "analyze");
    if (!perIp.allowed) return tooMany(request, perIp);

    try {
      // The signals analyst's search plan is a Gemini call (unless cached), so it counts.
      const ai = await aiAllowed(request, deps);
      const { packet, gated, trace } = await currentEvidence(
        parsed.data.idea,
        deps,
        request.signal,
        ai,
      );
      await deps.record?.(packet).catch(() => {});
      // The full packet is returned, including markets the gate would not use.
      return json(request, 200, {
        packet,
        gate: {
          passed: gated.ok,
          summary: gated.summary,
          ...(gated.ok ? {} : { reason: gated.message }),
        },
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

    return answer(
      request,
      deps,
      { kind: "decide", key: decideCacheKey(idea, packet) },
      async (ai) =>
        unwrap(await decideFromPacket(idea, packet, pipelineDeps(deps, ai), request.signal), deps),
    );
  }
  return { POST, OPTIONS };
}
