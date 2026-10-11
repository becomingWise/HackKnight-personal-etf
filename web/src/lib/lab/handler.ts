// /api/lab/*: Shaun's paper-trading Lab (experiment/ at the repository root) hosted on Vercel.
// The answers come from the Lab's own modules, copied to src/lib/agent-core/experiment by
// `pnpm sync:lab`; this file only adds HTTP, our CORS and our rate limits.
//   GET  /api/lab/overview            the companies the Lab can price, and the snapshot time
//   GET  /api/lab/events?symbol=NVDA  the events linked to one company
//   POST /api/lab/analysis            { symbols } -> allocations, basket history, events, fits
//   POST /api/lab/stocks              { idea, preferences? } -> 7 to 10 companies from the live agent
// Data is the Lab's committed snapshot, read-only: there is no refresh route here. Paper money
// never reaches this server; it lives in the browser. Contract: docs/API.md section 1g.
import { createHash } from "node:crypto";
import { AgentError } from "../agent-core/agent/gemini.js";
import { analyzeBasket, stockEvents } from "../agent-core/experiment/data.js";
import { COMPANIES, createSuggestionService } from "../agent-core/experiment/suggestions.js";
import { agentBudget } from "../agentApi/adapters";
import { tigerApiCache, type ApiCache } from "../cache/apiCache";
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { error, json } from "../http/respond";
import { geminiBudget } from "../sponsors/gemini";
import { snapshot as committedSnapshot, type LabSnapshot } from "./snapshot";

type Suggestion = {
  summary: string;
  stocks: { symbol: string; name: string }[];
  source: string;
  preferences: string[];
  reused: boolean;
};
export type LabSuggest = (
  input: { idea: string; mode: "gemini"; preferences?: unknown },
  options: { signal?: AbortSignal; sessionId?: string; events: unknown[] },
) => Promise<Suggestion>;

export type LabDeps = {
  snapshot: LabSnapshot;
  suggest: LabSuggest;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

const MAX_BODY_BYTES = 16 * 1024;
const MAX_IDEA_LENGTH = 500;
// The shortlist spends the same Gemini budget as POST /api/stocks, so it counts against the same
// per-IP limits: the Lab is not a second allowance.
const STOCKS_PER_IP_PER_MINUTE = 30;
const STOCKS_PER_IP_PER_DAY = 600;
// The other routes only compute on the bundled snapshot.
const READS_PER_IP_PER_MINUTE = 120;

/**
 * The Lab's suggestion cache on top of the shared response cache (kind "lab"). The Lab's keys are
 * long JSON strings (idea, preferences, the event odds it saw), so they are stored hashed.
 */
export function labCache(cache: ApiCache = tigerApiCache) {
  const hashed = (key: string) => createHash("sha256").update(key).digest("hex");
  return {
    async get(key: string) {
      return (await cache.get("lab", hashed(key)))?.value ?? null;
    },
    async set(key: string, value: unknown, ttlMs: number) {
      await cache.set("lab", hashed(key), value, Math.round(ttlMs / 1000));
    },
  };
}

let service: LabSuggest | undefined;

export const defaultLabDeps: LabDeps = {
  snapshot: committedSnapshot,
  // Built on first use, so importing this module never needs the database or a key.
  // The Lab's own service in Gemini mode: its prompt and its 7 to 10 company range on our agent,
  // with the per-model Gemini budgets every other call here goes through. Session preferences
  // stay as the Lab keeps them: sent by the browser with each request, held in memory only.
  suggest: (input, options) => {
    service ??= createSuggestionService({
      cache: labCache(),
      budget: agentBudget(geminiBudget),
      log: (event: object) => console.log(JSON.stringify({ at: "lab", ...event })),
    } as never) as unknown as LabSuggest;
    return service(input, options);
  },
  rateLimit: hit,
};

const message = (err: unknown, fallback: string) =>
  err instanceof Error && err.message ? err.message : fallback;

export function createLabHandlers(deps: LabDeps = defaultLabDeps) {
  const tooMany = (request: Request, rate: RateResult) =>
    error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
      "Retry-After": String(rate.retryAfterSeconds),
    });

  async function readLimit(request: Request): Promise<Response | null> {
    const ip = ipKey(clientIp(request));
    const rate = await deps.rateLimit([
      { bucket: `lab:ip:${ip}`, windowSeconds: 60, max: READS_PER_IP_PER_MINUTE },
    ]);
    return rate.allowed ? null : tooMany(request, rate);
  }

  async function body(request: Request): Promise<Record<string, unknown> | Response> {
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) {
        return error(request, 413, "invalid_request", "The request is too large.");
      }
      const parsed: unknown = JSON.parse(raw);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed as Record<string, unknown>;
    } catch {
      return error(request, 400, "invalid_request", "Use a JSON request.");
    }
  }

  async function overview(request: Request): Promise<Response> {
    const limited = await readLimit(request);
    if (limited) return limited;
    const { snapshot } = deps;
    return json(request, 200, {
      builtAt: snapshot.builtAt,
      note: snapshot.note,
      suggestionMode: "gemini",
      // The hosted Lab serves a committed snapshot; there is no refresh.
      readOnly: true,
      stocks: COMPANIES.map((stock) => ({
        ...stock,
        lastClose: snapshot.stocks[stock.symbol]?.prices.at(-1) ?? null,
        eventCount: snapshot.events.filter(
          (event) => event.linkedSymbols.includes(stock.symbol) && event.status === "available",
        ).length,
      })),
    });
  }

  async function events(request: Request): Promise<Response> {
    const limited = await readLimit(request);
    if (limited) return limited;
    const symbol = new URL(request.url).searchParams.get("symbol");
    if (!symbol || !COMPANIES.some((stock) => stock.symbol === symbol)) {
      return error(request, 400, "invalid_request", "Unknown company ticker.");
    }
    const { snapshot } = deps;
    return json(request, 200, {
      symbol,
      builtAt: snapshot.builtAt,
      events: stockEvents(snapshot as never, symbol),
    });
  }

  async function analysis(request: Request): Promise<Response> {
    const limited = await readLimit(request);
    if (limited) return limited;
    const parsed = await body(request);
    if (parsed instanceof Response) return parsed;
    try {
      return json(request, 200, analyzeBasket(deps.snapshot as never, parsed.symbols as never));
    } catch (err) {
      return error(request, 400, "invalid_request", message(err, "Invalid basket."));
    }
  }

  async function stocks(request: Request): Promise<Response> {
    const parsed = await body(request);
    if (parsed instanceof Response) return parsed;
    const idea = parsed.idea;
    if (typeof idea !== "string" || !idea.trim() || idea.length > MAX_IDEA_LENGTH) {
      return error(request, 400, "invalid_idea", "Enter an idea between 1 and 500 characters.");
    }

    const ip = ipKey(clientIp(request));
    const rate = await deps.rateLimit([
      { bucket: `findstocks:ip:${ip}`, windowSeconds: 60, max: STOCKS_PER_IP_PER_MINUTE },
      { bucket: `findstocks:ipday:${ip}`, windowSeconds: 86_400, max: STOCKS_PER_IP_PER_DAY },
    ]);
    if (!rate.allowed) return tooMany(request, rate);

    try {
      // Always the live agent: the Lab's keyword "preview" mode is for local use only.
      const result = await deps.suggest(
        { idea, mode: "gemini", preferences: parsed.preferences },
        {
          signal: request.signal,
          sessionId: request.headers.get("x-session-id") ?? undefined,
          events: deps.snapshot.events,
        },
      );
      const { reused, ...answer } = result;
      return json(request, 200, answer, { "X-Cache": reused ? "HIT" : "MISS" });
    } catch (err) {
      if (err instanceof AgentError) {
        deps.log?.("lab_agent_error", { code: err.code, message: err.message.slice(0, 200) });
        // The same error shape as the Lab's own server: a clarification carries the ideas to
        // pick from, and the session's preferences when it has some.
        const { options, preferences } = err as { options?: unknown; preferences?: unknown };
        return json(request, err.status, {
          error: {
            code: err.code,
            message: err.message,
            ...(Array.isArray(options) ? { options } : {}),
            ...(Array.isArray(preferences) ? { preferences } : {}),
          },
        });
      }
      deps.log?.("lab_error", { message: message(err, "unknown").slice(0, 200) });
      return error(request, 502, "upstream_error", "The stock service failed. Please try again.");
    }
  }

  return {
    overview,
    events,
    analysis,
    stocks,
    OPTIONS: (request: Request): Response => preflight(request),
  };
}

export const labHandlers = createLabHandlers();
