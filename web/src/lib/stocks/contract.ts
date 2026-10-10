// The POST /api/stocks contract (docs/API.md section 1, the team's "Stock selection port") and
// the odds helpers shared by the pipeline stages. The pipeline itself lives in ../pipeline.
import { z } from "zod";

export const MIN_STOCKS = 3;
export const MAX_STOCKS = 5;
export const MAX_IDEA_LENGTH = 500;

export const requestSchema = z.object({
  idea: z
    .string({ error: "idea must be a string" })
    .trim()
    .min(1, "idea must be a non-empty string")
    .max(MAX_IDEA_LENGTH, `idea must be at most ${MAX_IDEA_LENGTH} characters`),
});

const nonEmpty = z.string().refine((s) => s.trim().length > 0, "must be non-empty");

/** One pipeline stage as reported to the client, e.g. { step: "gate", status: "ok", summary: "passed: …" }. */
export const traceStepSchema = z.object({
  step: z.enum(["analyst", "gate", "decider", "checker"]),
  /** ok: as planned. warn: worked with a caveat (revision, backup analyst, stocks dropped). failed / skipped: see summary. */
  status: z.enum(["ok", "warn", "failed", "skipped"]),
  ms: z.number().min(0),
  summary: z.string(),
});

export type TraceStep = z.infer<typeof traceStepSchema>;

/** The response shape in docs/API.md. `summary` and `stocks[].{symbol,name,reason}` are the contract; the rest is optional extra. */
export const responseSchema = z.object({
  summary: z.string(),
  stocks: z
    .array(
      z.object({
        symbol: nonEmpty,
        name: nonEmpty,
        reason: nonEmpty,
        marketId: z.string().nullable(),
      }),
    )
    .min(MIN_STOCKS)
    .max(MAX_STOCKS),
  source: z.enum(["gemini", "fallback"]),
  markets: z.array(
    z.object({
      id: z.string(),
      title: nonEmpty,
      url: z.url(),
      outcome: z.literal("Yes"),
      probability: z.number().min(0).max(1),
      observedAt: z.iso.datetime(),
    }),
  ),
  trace: z.array(traceStepSchema).optional(),
});

export type FindStocksResponse = z.infer<typeof responseSchema>;

export class NoMatchError extends Error {
  constructor() {
    super("No stocks in the supported universe match this idea.");
  }
}

/** 0.075 → "7.5", 0.72 → "72": the way odds are quoted in reasons. */
export function formatOdds(probability: number): string {
  const pct = probability * 100;
  if (pct < 10 || pct > 90) return String(Math.round(pct * 10) / 10);
  return String(Math.round(pct));
}

/** The percentages a text quotes: "72%", "7,5 %", "12 percent". */
export function quotedPercents(text: string): number[] {
  return [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:%|％|percent\b)/gi)].map((m) =>
    Number(m[1].replace(",", ".")),
  );
}

/** True when the value is within 1 point of the market's Yes or No odds. */
export function matchesOdds(percent: number, probability: number): boolean {
  const yes = probability * 100;
  return Math.abs(percent - yes) <= 1 || Math.abs(percent - (100 - yes)) <= 1;
}

/** True when every percentage in the text is within 1 point of an allowed market's Yes or No odds. */
export function oddsAreAccurate(text: string, markets: { probability: number }[]): boolean {
  return quotedPercents(text).every((value) =>
    markets.some((m) => matchesOdds(value, m.probability)),
  );
}
