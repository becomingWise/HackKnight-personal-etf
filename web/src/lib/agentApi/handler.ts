// POST /api/stocks: the team's findStocks port, answered by the stock agent in /agent (copied to
// src/lib/agent-core by `pnpm sync:agent`). The response is exactly the agent's:
//   { summary, stocks: [{ symbol, name }] }   (+ `basket` when the body says "basket": true)
// Failures are errors, never substitute companies. Contract: docs/API.md section 1.
import { AgentError, createFindStocks } from "../agent-core/agent/gemini.js";
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { error, json } from "../http/respond";
import { geminiBudget } from "../sponsors/gemini";
import { agentBudget, agentCache, tigerAgentMemory } from "./adapters";

type Selection = {
  summary: string;
  stocks: { symbol: string; name: string }[];
  basket?: unknown;
};
export type FindStocks = (
  input: { idea: unknown },
  options: { signal?: AbortSignal; sessionId?: string; basket?: boolean },
) => Promise<Selection>;

export type AgentHandlerDeps = {
  findStocks: FindStocks;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

const MAX_BODY_BYTES = 16 * 1024;
const PER_IP_PER_MINUTE = 30;
const PER_IP_PER_DAY = 600;

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
      const result = await deps.findStocks(
        { idea: body?.idea },
        { signal: request.signal, sessionId, basket: body?.basket === true },
      );
      return json(request, 200, result);
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
