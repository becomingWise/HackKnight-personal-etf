// How many requests may use Gemini. The per-model budgets (src/lib/gemini) stop any single model
// from going over its quota; these caps sit in front of them so that a burst of visitors, or one
// judging session, cannot spend the day's calls. They are derived from the same model limits.
// A request over a cap is not refused: it is answered without Gemini (keyword search and the
// evidence-only selection).
import { env } from "../env";
import { CHAINS, MODELS, budgetOf, type ModelSpec } from "../gemini/models";
import type { Limit } from "../http/rateLimit";

/** Share of the workflow models' daily budget that visitors' requests may use; the rest is for the warm job and evals. */
const DAY_SHARE = 0.9;
/** One 30-minute window (a judging session) may use at most this share of the day's requests. */
const SESSION_SHARE = 0.4;

export type AiCaps = {
  /** Worst-case Gemini calls of one uncached request: search plan, decision, one revision (and the optional review). */
  callsPerRequest: number;
  /** Uncached requests that may use Gemini, across all servers and visitors. */
  perMinute: number;
  per30Minutes: number;
  perDay: number;
  /** And per visitor IP, so one person cannot use up a session's share. */
  perIp30Minutes: number;
};

export function aiCaps(checkerLlm: boolean = env().CHECKER_LLM): AiCaps {
  // What the decider's chain can deliver; the retiring last-resort models are not counted on.
  const models = CHAINS.decide.filter((m) => !(MODELS[m] as ModelSpec).retiring);
  const minute = models.reduce((sum, m) => sum + budgetOf(m).perMinute, 0);
  const day = models.reduce((sum, m) => sum + budgetOf(m).perDay, 0);
  const callsPerRequest = 3 + (checkerLlm ? 1 : 0);
  const perDay = Math.max(1, Math.floor((day * DAY_SHARE) / callsPerRequest));
  const per30Minutes = Math.max(1, Math.floor(perDay * SESSION_SHARE));
  return {
    callsPerRequest,
    perMinute: Math.max(1, Math.floor(minute / callsPerRequest)),
    per30Minutes,
    perDay,
    perIp30Minutes: Math.max(1, Math.ceil(per30Minutes / 2)),
  };
}

/** The counters one uncached request is checked against. */
export function aiBuckets(ipKey: string, caps: AiCaps = aiCaps()): Limit[] {
  return [
    { bucket: "ai:minute", windowSeconds: 60, max: caps.perMinute },
    { bucket: "ai:30min", windowSeconds: 1800, max: caps.per30Minutes },
    { bucket: "ai:day", windowSeconds: 86_400, max: caps.perDay },
    { bucket: `ai:ip30min:${ipKey}`, windowSeconds: 1800, max: caps.perIp30Minutes },
  ];
}
