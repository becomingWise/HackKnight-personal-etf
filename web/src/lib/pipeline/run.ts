// The decision workflow: analyst → gate → decider → checker, a fixed code path where each stage
// is one small function and reports one line to the trace. Gemini is called at most twice per
// request (the decision and one revision), three times with CHECKER_LLM on.
import { analyze } from "../analyst";
import { createMockAnalyst, type MockAnalystDeps } from "../analyst/mock";
import { evidencePacketSchema, type Analyst, type EvidencePacket } from "../analyst/packet";
import { createTigerAnalyst } from "../analyst/tiger";
import { env } from "../env";
import type { GenerateJson } from "../sponsors/gemini";
import {
  MAX_STOCKS,
  MIN_STOCKS,
  NoMatchError,
  formatOdds,
  type FindStocksResponse,
  type TraceStep,
} from "../stocks/contract";
import { STOCK_BY_SYMBOL } from "../stocks/universe";
import type { DeciderModel } from "./budget";
import { check, llmReview, type CheckResult, type DecidedStock } from "./checker";
import { DECIDER_SYSTEM, DECISION_JSON_SCHEMA, deciderPrompt, revisionPrompt } from "./decider";
import { gate } from "./gate";

export const MAX_DECIDER_CALLS = 2;
/** Total time Gemini may use before the evidence-only fallback takes over. */
const GEMINI_BUDGET_MS = 20_000;

export type AnalystMode = "mock" | "module" | "tiger";

export function analystMode(value: string | undefined = env().ANALYST_MODE): AnalystMode {
  const mode = (value ?? "mock").toLowerCase();
  return mode === "module" || mode === "tiger" ? mode : "mock";
}

export function defaultAnalysts(mock: MockAnalystDeps): Record<AnalystMode, Analyst> {
  return { mock: createMockAnalyst(mock), module: analyze, tiger: createTigerAnalyst(mock) };
}

export type PipelineDeps = {
  generate: GenerateJson;
  analysts: Record<AnalystMode, Analyst>;
  mode: AnalystMode;
  /** Which model decides: the lighter one by default (DECIDER_MODEL). */
  deciderModel?: DeciderModel;
  /** Adds the LLM review to the checker (one more Gemini call). */
  checkerLlm: boolean;
  /** False when the Gemini budget is used up: the decider is skipped. */
  deciderBudget?: () => Promise<boolean>;
  /** Receives the packet as soon as the analyst is done, e.g. to record its odds. */
  onPacket?: (packet: EvidencePacket) => void;
  now?: () => Date;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

export type PipelineResult =
  | {
      ok: true;
      response: FindStocksResponse;
      /** The stocks with every market they cite (the response keeps only the first id). */
      decided: DecidedStock[];
      /** The first answer Gemini gave, before any revision. For evals. */
      firstAnswer: unknown;
      geminiCalls: number;
    }
  | { ok: false; code: "not_enough_evidence"; message: string; trace: TraceStep[] };

// ---------- Stage a: analyst ----------

/** Runs the configured analyst; if it fails, the mock answers and the packet says so. */
export async function runAnalyst(
  idea: string,
  deps: Pick<PipelineDeps, "analysts" | "mode" | "log">,
  signal?: AbortSignal,
): Promise<{ packet: EvidencePacket; step: TraceStep }> {
  const started = Date.now();
  let packet: EvidencePacket;
  let used = deps.mode;
  try {
    packet = evidencePacketSchema.parse(await deps.analysts[deps.mode](idea, signal));
  } catch (err) {
    if (deps.mode === "mock" || signal?.aborted) throw err;
    const why = err instanceof Error ? err.message.slice(0, 120) : "unknown error";
    deps.log?.("analyst_failed", { mode: deps.mode, why });
    packet = evidencePacketSchema.parse(await deps.analysts.mock(idea, signal));
    packet.warnings.unshift(`The ${deps.mode} analyst failed (${why}); the mock analyst answered.`);
    used = "mock";
  }
  return {
    packet,
    step: {
      step: "analyst",
      status: used === deps.mode ? "ok" : "warn",
      ms: Date.now() - started,
      summary:
        `${packet.markets.length} markets, ${packet.themes.length} themes, ${packet.tickerSignals.length} ticker signals (${used})` +
        (used === deps.mode ? "" : `; the ${deps.mode} analyst failed`),
    },
  };
}

// ---------- Answer in the /api/stocks shape ----------

function buildResponse(
  packet: EvidencePacket,
  summary: string,
  stocks: DecidedStock[],
  source: FindStocksResponse["source"],
): FindStocksResponse {
  const citedIds = new Set(stocks.flatMap((s) => s.marketIds));
  const cited = packet.markets.filter((m) => citedIds.has(m.id));
  // The key odds are appended by the server from the packet, never written by the model.
  const odds = cited.slice(0, 3).map((m) => `"${m.question}" ${formatOdds(m.probability)}%`);
  const observedAt = new Date(packet.generatedAt).toISOString();
  return {
    summary: summary + (odds.length ? ` Key Polymarket odds: ${odds.join("; ")}.` : ""),
    stocks: stocks.map((s) => ({
      symbol: s.symbol,
      name: STOCK_BY_SYMBOL.get(s.symbol)!.name,
      reason: s.reason,
      marketId: s.marketIds[0] ?? null,
    })),
    source,
    markets: cited.map((m) => ({
      id: m.id,
      title: m.question,
      url: m.url,
      outcome: "Yes" as const,
      probability: m.probability,
      observedAt,
    })),
  };
}

/** The answer without Gemini: the analyst's first ticker signals (it lists the most important first), each with its market. */
export function fallbackFromPacket(packet: EvidencePacket): {
  summary: string;
  stocks: DecidedStock[];
} {
  const seen = new Set<string>();
  const ranked = packet.tickerSignals
    .filter((t) => STOCK_BY_SYMBOL.has(t.symbol) && !seen.has(t.symbol) && seen.add(t.symbol))
    .slice(0, MAX_STOCKS);
  if (ranked.length < MIN_STOCKS) throw new NoMatchError();
  return {
    summary:
      "Evidence-only selection (AI ranking was unavailable, so this is a simpler one): the stocks most strongly linked to the Polymarket markets found for your idea.",
    stocks: ranked.map((t) => {
      // The ticker's first market is the one its `why` is about.
      const market = packet.markets.find((m) => m.id === t.marketIds[0])!;
      return {
        symbol: t.symbol,
        marketIds: [market.id],
        reason: `Polymarket gives ${formatOdds(market.probability)}% to "${market.question}". ${t.why}`,
      };
    }),
  };
}

// ---------- Stages b to d ----------

/** Gate → decider → checker for a packet that already exists. This is POST /api/decide. */
export async function decideFromPacket(
  idea: string,
  input: EvidencePacket,
  deps: Pick<
    PipelineDeps,
    "generate" | "deciderModel" | "checkerLlm" | "deciderBudget" | "now" | "log"
  >,
  signal?: AbortSignal,
  trace: TraceStep[] = [],
): Promise<PipelineResult> {
  const step = (s: TraceStep) => trace.push(s);

  // b. Gate
  let started = Date.now();
  const gated = gate(input, deps.now?.() ?? new Date());
  step({
    step: "gate",
    status: gated.ok ? "ok" : "failed",
    ms: Date.now() - started,
    summary: gated.summary,
  });
  if (!gated.ok) {
    step({ step: "decider", status: "skipped", ms: 0, summary: "not called: the gate failed" });
    return { ok: false, code: "not_enough_evidence", message: gated.message, trace };
  }
  const packet = gated.packet;

  // c + d. Decide, check, and revise at most once.
  started = Date.now();
  const remaining = () => GEMINI_BUDGET_MS - (Date.now() - started);
  const base = deciderPrompt(idea, packet);
  const model = deps.deciderModel ?? "lite";
  let calls = 0;
  let geminiCalls = 0;
  let revisions = 0;
  let reviewMs = 0;
  let reviewed = false;
  let failedCall = false;
  let firstAnswer: unknown = null;
  let feedback: { previous: unknown; errors: string[] } | null = null;
  let last: CheckResult | null = null;
  const budgetOk = deps.deciderBudget ? await deps.deciderBudget() : true;

  while (budgetOk && calls < MAX_DECIDER_CALLS && remaining() > 3000) {
    calls++;
    geminiCalls++;
    let raw: unknown;
    try {
      raw = await deps.generate({
        system: DECIDER_SYSTEM,
        prompt: feedback ? revisionPrompt(base, feedback.previous, feedback.errors) : base,
        schema: DECISION_JSON_SCHEMA,
        timeoutMs: Math.min(10_000, remaining()),
        // After a failed or timed-out call, the next one goes to the lighter, faster model.
        prefer: failedCall ? "lite" : model,
        // The main model is an opt-in upgrade: the lighter one never spills over to it.
        fallback: model === "main",
        signal,
      });
    } catch (err) {
      if (signal?.aborted) throw err;
      failedCall = true;
      deps.log?.("gemini_error", {
        call: calls,
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      });
      continue;
    }
    if (feedback) revisions++;
    firstAnswer ??= raw;
    last = check(raw, packet);
    if (!last.errors.length && deps.checkerLlm && !reviewed && calls < MAX_DECIDER_CALLS) {
      reviewed = true;
      geminiCalls++;
      const reviewStarted = Date.now();
      // A failed review never blocks an answer that passed the code checks.
      const issues = await llmReview(idea, packet, last.stocks, deps.generate, signal).catch(
        () => [],
      );
      reviewMs = Date.now() - reviewStarted;
      if (issues.length) last = { ...last, errors: issues };
    }
    if (!last.errors.length) break;
    deps.log?.("checker_rejected", { call: calls, errors: last.errors.slice(0, 5) });
    feedback = { previous: raw, errors: last.errors };
  }
  const deciderMs = Date.now() - started - reviewMs;
  const revised = revisions ? `${revisions} revision` : "no revision";
  const review = reviewed ? ", LLM review on" : "";

  let answer: { summary: string; stocks: DecidedStock[] };
  let source: FindStocksResponse["source"] = "gemini";
  if (last && !last.errors.length && last.summary) {
    step({
      step: "decider",
      status: "ok",
      ms: deciderMs,
      summary: `${last.stocks.length} stocks (${calls} Gemini ${calls === 1 ? "call" : "calls"})`,
    });
    step({
      step: "checker",
      status: revisions ? "warn" : "ok",
      ms: reviewMs,
      summary: `passed, ${revised}${review}`,
    });
    answer = { summary: last.summary, stocks: last.stocks };
  } else if (last && last.stocks.length >= MIN_STOCKS) {
    // Still failing after the revision, but enough stocks pass on their own: keep those.
    step({
      step: "decider",
      status: "ok",
      ms: deciderMs,
      summary: `${last.stocks.length} stocks (${calls} Gemini ${calls === 1 ? "call" : "calls"})`,
    });
    step({
      step: "checker",
      status: "warn",
      ms: reviewMs,
      summary: `${revised}${review}; kept the ${last.stocks.length} stocks that pass, dropped the rest`,
    });
    answer = {
      summary:
        last.summary ??
        "These stocks are the ones most exposed to the Polymarket markets found for your idea.",
      stocks: last.stocks,
    };
  } else {
    answer = fallbackFromPacket(packet);
    source = "fallback";
    const why = !budgetOk
      ? "skipped: the Gemini budget for this minute or day is used up"
      : last
        ? `answer rejected after ${calls} Gemini ${calls === 1 ? "call" : "calls"}`
        : `Gemini unavailable (${calls} ${calls === 1 ? "call" : "calls"} failed)`;
    step({ step: "decider", status: budgetOk ? "failed" : "skipped", ms: deciderMs, summary: why });
    step({
      step: "checker",
      status: "warn",
      ms: reviewMs,
      summary: `evidence-only fallback: ${answer.stocks.length} stocks from the analyst's ticker signals`,
    });
  }

  return {
    ok: true,
    response: { ...buildResponse(packet, answer.summary, answer.stocks, source), trace },
    decided: answer.stocks,
    firstAnswer,
    geminiCalls,
  };
}

/** The whole workflow for one idea. This is POST /api/stocks. */
export async function runPipeline(
  idea: string,
  deps: PipelineDeps,
  signal?: AbortSignal,
): Promise<PipelineResult> {
  const { packet, step } = await runAnalyst(idea, deps, signal);
  deps.onPacket?.(packet);
  return decideFromPacket(idea, packet, deps, signal, [step]);
}
