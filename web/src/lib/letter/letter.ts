// The "manager's note": a short letter explaining a saved basket, written by Gemini from the
// basket's own data, with a template fallback when Gemini is unavailable.
import { z } from "zod";
import type { Basket } from "../baskets/schema";
import { ThinkingLevel, type GenerateJson } from "../sponsors/gemini";
import { formatOdds } from "../stocks/findStocks";

export const MAX_WORDS = 120;
const MAX_CHARS = 1200;
/** Total time Gemini may use before the template takes over. */
const GEMINI_BUDGET_MS = 20_000;

export type LetterResult = { letter: string; source: "gemini" | "fallback" };

const letterSchema = z.object({ letter: z.string().trim().min(40).max(MAX_CHARS) });
const LETTER_JSON_SCHEMA = {
  type: "object",
  properties: { letter: { type: "string" } },
  required: ["letter"],
};

const SYSTEM = `You write the "manager's note" for a personal paper portfolio: a short letter to the person who built it.

Rules:
- At most ${MAX_WORDS} words, as one or two plain paragraphs. No headings, lists, markdown or sign-off.
- Explain what the basket is betting on, which holdings carry the most weight and why, and which Polymarket markets back it.
- Use ONLY the facts given. Every percentage you mention must be one of the given weights or market odds, copied exactly. Do not invent numbers, dates, prices or events.
- Polymarket odds are event probabilities, not forecasts of stock returns. Never promise performance or give investment advice.
- Write in the same language as the user's idea. Keep ticker symbols as given.
- Turn each market question into a natural clause that keeps its meaning and its date, for example "an 11% chance that China invades Taiwan by the end of 2027". Do not paste the question itself.`;

export function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/** Every percentage in the text must be a weight or the Yes/No odds of a cited market (within 1 point). */
export function numbersAreGrounded(
  text: string,
  basket: Pick<Basket, "stocks" | "markets">,
): boolean {
  const allowed = [
    ...basket.stocks.map((s) => s.weightPct),
    ...basket.markets.flatMap((m) => [m.probability * 100, 100 - m.probability * 100]),
  ];
  const quoted = [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*[%％]/g)].map((m) =>
    Number(m[1].replace(",", ".")),
  );
  return quoted.every((value) => allowed.some((a) => Math.abs(value - a) <= 1));
}

function facts(basket: Basket): string {
  const stocks = [...basket.stocks]
    .sort((a, b) => b.weightPct - a.weightPct)
    .map((s) => `- ${s.symbol} (${s.name}): ${s.weightPct}% — ${s.reason}`)
    .join("\n");
  const markets = basket.markets.length
    ? basket.markets
        .map((m) => `- "${m.title}": Yes ${formatOdds(m.probability)}% when the basket was built`)
        .join("\n")
    : "- none";
  return (
    `User's idea: ${basket.idea}\n\n` +
    `Holdings and weights:\n${stocks}\n\n` +
    `How the weights were set: ${basket.weights.explanation || "equal weights"}\n\n` +
    `Polymarket markets cited:\n${markets}`
  );
}

/** Deterministic letter from the basket's data, used when Gemini fails or times out. */
export function fallbackLetter(basket: Basket): string {
  const holdings = [...basket.stocks]
    .sort((a, b) => b.weightPct - a.weightPct)
    .map((s) => `${s.symbol} ${s.weightPct}%`)
    .join(", ");
  const weights =
    basket.weights.status === "adjusted"
      ? "Weights were tilted by how the linked Polymarket odds moved over the past week."
      : "The holdings keep their starting weights.";
  const odds = basket.markets
    .slice(0, 3)
    .map((m) => `"${m.title}" at ${formatOdds(m.probability)}%`)
    .join("; ");
  return (
    `This basket follows the idea "${basket.idea}" with ${basket.stocks.length} holdings: ${holdings}. ${weights}` +
    (odds ? ` Polymarket odds when it was built: ${odds}.` : "") +
    " These are event probabilities, not forecasts of returns."
  );
}

export type LetterDeps = {
  generate: GenerateJson;
  log?: (event: string, detail?: Record<string, unknown>) => void;
};

export async function writeLetter(
  basket: Basket,
  deps: LetterDeps,
  abort?: AbortSignal,
): Promise<LetterResult> {
  const started = Date.now();
  const remaining = () => GEMINI_BUDGET_MS - (Date.now() - started);
  const prompt = facts(basket);
  let problem = "";
  // After a failed or timed-out call, the retry goes to the other model.
  let failed = false;
  for (let attempt = 1; attempt <= 2 && remaining() > 3000; attempt++) {
    try {
      const raw = await deps.generate({
        system: SYSTEM,
        prompt: problem
          ? `${prompt}\n\nYour previous letter was rejected: ${problem} Write it again.`
          : prompt,
        schema: LETTER_JSON_SCHEMA,
        timeoutMs: Math.min(7000, remaining()),
        // Minimal thinking: with more, the main model often takes over 8 s for this prompt.
        thinking: ThinkingLevel.MINIMAL,
        // The main model writes noticeably better prose here (the lighter one pastes market
        // questions verbatim); the lighter model is still the backup when the quota is hit.
        prefer: failed ? "lite" : "main",
        signal: abort,
      });
      const parsed = letterSchema.safeParse(raw);
      if (!parsed.success) problem = "It was empty, too short or too long.";
      else if (wordCount(parsed.data.letter) > MAX_WORDS) {
        problem = `It had ${wordCount(parsed.data.letter)} words; the limit is ${MAX_WORDS}.`;
      } else if (!numbersAreGrounded(parsed.data.letter, basket)) {
        problem = "It contained a percentage that is not one of the given weights or odds.";
      } else {
        return { letter: parsed.data.letter, source: "gemini" };
      }
      deps.log?.("gemini_invalid", { attempt, problem });
    } catch (err) {
      if (abort?.aborted) throw err;
      problem = "";
      failed = true;
      deps.log?.("gemini_error", {
        attempt,
        message: err instanceof Error ? err.message.slice(0, 200) : "unknown",
      });
    }
  }
  deps.log?.("fallback", { elapsed_ms: Date.now() - started });
  return { letter: fallbackLetter(basket), source: "fallback" };
}
