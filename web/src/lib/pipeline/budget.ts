// How many requests may use Gemini. Everything here is derived from the account's limits
// (GEMINI_LITE_RPM / _RPD and GEMINI_FLASH_RPM / _RPD), so changing a limit changes every cap.
// A request over a cap is not refused: it is answered without Gemini (keyword search and the
// evidence-only selection).
import { env, type Env } from "../env";
import type { Limit } from "../http/rateLimit";

export type ModelLimits = { rpm: number; rpd: number };
export type DeciderModel = "lite" | "main";

/** Used until the real numbers from AI Studio are set. The per-minute values were measured; the per-day values are cautious guesses. */
export const ASSUMED_LIMITS: { lite: ModelLimits; flash: ModelLimits } = {
  lite: { rpm: 15, rpd: 200 },
  flash: { rpm: 5, rpd: 40 },
};

/** Share of a model's quota that visitors' requests may use; the rest is for the warm job, manager's notes and evals. */
const MINUTE_SHARE = 0.8;
const DAY_SHARE = 0.75;
/** One 30-minute window (a judging session) may use at most this share of the day's requests. */
const SESSION_SHARE = 0.4;

const positive = (value: string | undefined, fallback: number) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function geminiLimits(e: Env = env()) {
  return {
    lite: {
      rpm: positive(e.GEMINI_LITE_RPM, ASSUMED_LIMITS.lite.rpm),
      rpd: positive(e.GEMINI_LITE_RPD, ASSUMED_LIMITS.lite.rpd),
    },
    flash: {
      rpm: positive(e.GEMINI_FLASH_RPM, ASSUMED_LIMITS.flash.rpm),
      rpd: positive(e.GEMINI_FLASH_RPD, ASSUMED_LIMITS.flash.rpd),
    },
  };
}

/** DECIDER_MODEL: the lighter model unless the main one is asked for by name. */
export function deciderModel(value: string | undefined = env().DECIDER_MODEL): DeciderModel {
  const v = (value ?? "").trim().toLowerCase();
  return v === "gemini-3.5-flash" || v === "flash" || v === "main" ? "main" : "lite";
}

export type AiCaps = {
  /** Worst-case Gemini calls one uncached request makes, per model. */
  callsPerRequest: { lite: number; flash: number };
  /** Uncached requests that may use Gemini, across all servers and visitors. */
  perMinute: number;
  per30Minutes: number;
  perDay: number;
  /** And per visitor IP, so one person cannot use up a session's share. */
  perIp30Minutes: number;
};

export function aiCaps(
  limits = geminiLimits(),
  model: DeciderModel = deciderModel(),
  checkerLlm: boolean = env().CHECKER_LLM,
): AiCaps {
  // The search plan and the optional review run on the lighter model; the decision and its one
  // revision on the decider's model.
  const calls = {
    lite: 1 + (checkerLlm ? 1 : 0) + (model === "lite" ? 2 : 0),
    flash: model === "main" ? 2 : 0,
  };
  const fit = (lite: number, flash: number) =>
    Math.max(
      1,
      Math.floor(Math.min(lite / calls.lite, calls.flash ? flash / calls.flash : Infinity)),
    );
  const perDay = fit(limits.lite.rpd * DAY_SHARE, limits.flash.rpd * DAY_SHARE);
  const per30Minutes = Math.max(1, Math.floor(perDay * SESSION_SHARE));
  return {
    callsPerRequest: calls,
    perMinute: fit(limits.lite.rpm * MINUTE_SHARE, limits.flash.rpm * MINUTE_SHARE),
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
