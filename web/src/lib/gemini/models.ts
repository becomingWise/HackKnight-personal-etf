// The one place that says which Gemini models exist for this project, what each may use of its
// free quota, and in which order each task tries them. The IDs are the API's own (checked with
// GET /v1beta/models on 2026-10-10); the limits are the AI Studio figures Lucas gave that day.

export type ModelSpec = {
  /** Free-tier requests per minute and per day, from AI Studio. */
  rpm: number;
  rpd: number;
  /** A last-resort model that is about to be retired; skipped for a day once it answers 404. */
  retiring?: boolean;
  /** Gemini 3 models take `thinkingLevel`; the 2.5 family does not. */
  thinkingLevel: boolean;
};

export const MODELS = {
  "gemini-3.5-flash-lite": { rpm: 15, rpd: 500, thinkingLevel: true },
  "gemini-3.1-flash-lite": { rpm: 15, rpd: 500, thinkingLevel: true },
  "gemini-3.8-flash": { rpm: 5, rpd: 20, thinkingLevel: true },
  // "Gemini 3 Flash" in AI Studio.
  "gemini-3-flash-preview": { rpm: 5, rpd: 20, thinkingLevel: true },
  "gemini-3.6-flash": { rpm: 5, rpd: 20, thinkingLevel: true },
  "gemini-3.5-flash": { rpm: 5, rpd: 20, thinkingLevel: true },
  // Retire on 2026-10-16.
  "gemini-2.5-flash": { rpm: 5, rpd: 20, retiring: true, thinkingLevel: false },
  "gemini-2.5-flash-lite": { rpm: 10, rpd: 20, retiring: true, thinkingLevel: false },
} as const satisfies Record<string, ModelSpec>;

export type ModelId = keyof typeof MODELS;
export const MODEL_IDS = Object.keys(MODELS) as ModelId[];

/** We stay this far under every limit. */
export const SAFETY = 0.8;

/** What the app lets itself use of a model: 80% of each limit. */
export function budgetOf(model: ModelId): { perMinute: number; perDay: number } {
  const spec: ModelSpec = MODELS[model];
  return {
    perMinute: Math.max(1, Math.floor(spec.rpm * SAFETY)),
    perDay: Math.max(1, Math.floor(spec.rpd * SAFETY)),
  };
}

/** What a Gemini call is for. Each task has its own chain of models. */
export type Task = "decide" | "plan" | "review" | "note" | "voteA" | "voteB";

// The workflow's own calls stay on the Flash-Lite models, which have real daily quota; when the
// whole chain is spent the answer comes from the evidence alone.
const LITE_CHAIN: ModelId[] = [
  "gemini-3.5-flash-lite",
  "gemini-3.1-flash-lite",
  "gemini-2.5-flash-lite",
];

export const CHAINS: Record<Task, ModelId[]> = {
  decide: LITE_CHAIN,
  plan: LITE_CHAIN,
  review: LITE_CHAIN,
  // The voting panel (src/lib/votes): five calls per request, split across the two Flash-Lite
  // models by alternating the chain each voter starts on. No other model ever votes.
  voteA: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"],
  voteB: ["gemini-3.1-flash-lite", "gemini-3.5-flash-lite"],
  // The manager's note is written once per basket, so it can afford the small Flash quotas.
  note: [
    "gemini-3.8-flash",
    "gemini-3-flash-preview",
    "gemini-3.6-flash",
    "gemini-3.5-flash",
    "gemini-3.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
  ],
};

/** The chain for a task. DECIDER_MODEL, when it names a known model, is tried first for decisions. */
export function chainFor(task: Task, deciderModel = process.env.DECIDER_MODEL): ModelId[] {
  const preferred = (deciderModel ?? "").trim() as ModelId;
  if (task === "decide" && preferred in MODELS) {
    return [preferred, ...CHAINS.decide.filter((m) => m !== preferred)];
  }
  return CHAINS[task];
}

/**
 * Google counts a day from midnight Pacific time; so do we. Returns the keys of the current
 * day and minute, and when each ends.
 */
export function periods(now: Date): {
  day: string;
  minute: string;
  minuteEnds: Date;
  dayEnds: Date;
} {
  const pacific = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: string) => pacific.find((p) => p.type === type)!.value;
  const secondsLeft =
    86_400 - (Number(part("hour")) * 3600 + Number(part("minute")) * 60 + Number(part("second")));
  const minuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
  return {
    day: `d:${part("year")}-${part("month")}-${part("day")}`,
    minute: `m:${new Date(minuteStart).toISOString().slice(0, 16)}`,
    minuteEnds: new Date(minuteStart + 60_000),
    dayEnds: new Date(now.getTime() + secondsLeft * 1000),
  };
}
