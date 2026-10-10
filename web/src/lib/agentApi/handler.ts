// POST /api/stocks: the team's findStocks port, answered by the stock agent in /agent (copied to
// src/lib/agent-core by `pnpm sync:agent`). The response is exactly the agent's:
//   { summary, stocks: [{ symbol, name }] }   (+ `basket` when the body says "basket": true)
// Failures are errors, never substitute companies. Contract: docs/API.md section 1.
// The live Polymarket signals of /api/weights go to the agent as context (no extra Gemini call);
// when they cannot be read the agent answers exactly as it does without them.
// Headers: X-Cache (HIT when no Gemini call was needed) and X-Odds-Moved. Every answer is counted
// for GET /api/savings.
import { AgentError, createFindStocks } from "../agent-core/agent/gemini.js";
import { oddsMovedHeader } from "../cache/apiCache";
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { error, json } from "../http/respond";
import { tigerSavings, type SavingsStore } from "../savings/store";
import { geminiBudget } from "../sponsors/gemini";
import type { Signal } from "../weights/engine";
import { liveSignals } from "../weights/signals";
import { agentBudget, agentCache, tigerAgentMemory } from "./adapters";

type Selection = {
  summary: string;
  stocks: { symbol: string; name: string }[];
  basket?: unknown;
};
/** How the agent made an answer: reused from its cache or with new Gemini calls. */
export type AgentReport = { reused: boolean; calls: number; oddsMoved: number | null };
export type FindStocks = (
  input: { idea: unknown },
  options: {
    signal?: AbortSignal;
    sessionId?: string;
    basket?: boolean;
    signals?: Signal[];
    report?: (detail: AgentReport) => void;
  },
) => Promise<Selection>;

export type AgentHandlerDeps = {
  findStocks: FindStocks;
  /** The live Polymarket signals; optional context, so a failure here never fails the request. */
  signals?: () => Promise<Signal[]>;
  /** Counts the served answer for GET /api/savings. */
  count?: SavingsStore["record"];
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

const MAX_BODY_BYTES = 16 * 1024;
const PER_IP_PER_MINUTE = 30;
const PER_IP_PER_DAY = 600;
/** A cold signal lookup is 11 Polymarket searches; the pick does not wait longer than this for it. */
const SIGNALS_WAIT_MS = 3_000;

async function signalsOrNone(load: AgentHandlerDeps["signals"]): Promise<Signal[] | undefined> {
  if (!load) return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      load(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(resolve, SIGNALS_WAIT_MS, undefined);
      }),
    ]);
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

let agent: FindStocks | undefined;

export const defaultAgentDeps: AgentHandlerDeps = {
  // Built on first use, so importing this module never needs the database or a key.
  findStocks: (input, options) => {
    agent ??= createFindStocks({
      memory: tigerAgentMemory(),
      cache: agentCache(),
      budget: agentBudget(geminiBudget),
      sessionId: null,
      log: (event: object) => console.log(JSON.stringify({ at: "agent", ...event })),
    }) as FindStocks;
    return agent(input, options);
  },
  signals: liveSignals,
  count: tigerSavings.record,
  rateLimit: hit,
};

export function createAgentStocksHandler(deps: AgentHandlerDeps = defaultAgentDeps) {
  async function POST(request: Request): Promise<Response> {
    let body: { idea?: unknown; basket?: unknown } | null;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) {
        return error(request, 400, "invalid_request", "The request body is too large.");
      }
      body = JSON.parse(raw);
    } catch {
      return error(
        request,
        400,
        "invalid_request",
        'The request body must be JSON: { "idea": string }.',
      );
    }

    const ip = ipKey(clientIp(request));
    const rate = await deps.rateLimit([
      { bucket: `findstocks:ip:${ip}`, windowSeconds: 60, max: PER_IP_PER_MINUTE },
      { bucket: `findstocks:ipday:${ip}`, windowSeconds: 86_400, max: PER_IP_PER_DAY },
    ]);
    if (!rate.allowed) {
      return error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
        "Retry-After": String(rate.retryAfterSeconds),
      });
    }

    try {
      const sessionId = request.headers.get("x-session-id") ?? undefined;
      const signals = await signalsOrNone(deps.signals);
      const made: { report?: AgentReport } = {};
      const result = await deps.findStocks(
        { idea: body?.idea },
        {
          signal: request.signal,
          sessionId,
          basket: body?.basket === true,
          signals,
          report: (detail) => {
            made.report = detail;
          },
        },
      );
      const reused = made.report?.reused === true;
      await deps.count?.("stocks", reused).catch(() => {});
      return json(request, 200, result, {
        "X-Cache": reused ? "HIT" : "MISS",
        ...oddsMovedHeader(made.report?.oddsMoved),
      });
    } catch (err) {
      if (err instanceof AgentError) {
        deps.log?.("agent_error", { code: err.code, message: err.message.slice(0, 200) });
        return error(request, err.status, err.code, err.message);
      }
      deps.log?.("error", {
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      });
      return error(request, 502, "upstream_error", "The stock service failed. Please try again.");
    }
  }
  return { POST, OPTIONS: (request: Request): Response => preflight(request) };
}
