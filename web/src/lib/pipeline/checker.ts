// Stage d, the CHECKER: code rules first (free and exact), then an optional LLM review. The
// errors it returns are written for the decider, which gets them back for its one revision.
import { z } from "zod";
import type { EvidencePacket, PacketMarket } from "../analyst/packet";
import { ThinkingLevel, type GenerateJson } from "../sponsors/gemini";
import {
  MAX_STOCKS,
  MIN_STOCKS,
  formatOdds,
  matchesOdds,
  quotedPercents,
} from "../stocks/contract";
import { STOCK_BY_SYMBOL } from "../stocks/universe";

export type DecidedStock = { symbol: string; marketIds: string[]; reason: string };

export type CheckResult = {
  /** Empty when the answer passed every rule. */
  errors: string[];
  /** The summary when it is usable. */
  summary: string | null;
  /** The stocks that pass every rule on their own: what can be kept if the revision fails too. */
  stocks: DecidedStock[];
};

// Loose on purpose: a wrong ticker or a missing citation should come back as a precise error
// from the rules below, not as "schema invalid".
const decisionSchema = z.object({
  summary: z.string().trim().min(10).max(900),
  stocks: z
    .array(
      z.object({
        symbol: z.string().trim().toUpperCase().min(1).max(10),
        marketIds: z.array(z.string().trim()).max(8),
        reason: z.string().trim().min(10).max(600),
      }),
    )
    .max(12),
});

/** Odds moves a text quotes in points: "1.2 pts", "3 points", "2 percentage points". */
export function quotedPoints(text: string): number[] {
  return [...text.matchAll(/(\d+(?:[.,]\d+)?)\s*(?:percentage[- ])?(?:pts?|points?)\b/gi)].map(
    (m) => Number(m[1].replace(",", ".")),
  );
}

/** True when the market moved by that many points (within 0.5) over 24 hours or 7 days. */
function matchesMove(points: number, market: PacketMarket): boolean {
  return [market.change24h, market.change7d].some(
    (c) => c !== null && Math.abs(Math.abs(c * 100) - points) <= 0.5,
  );
}

export function check(raw: unknown, packet: EvidencePacket): CheckResult {
  const parsed = decisionSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      errors: [
        "The answer did not follow the JSON schema { summary, stocks: [{ symbol, marketIds, reason }] }.",
      ],
      summary: null,
      stocks: [],
    };
  }
  const byId = new Map(packet.markets.map((m) => [m.id, m]));
  const errors: string[] = [];
  const stocks: DecidedStock[] = [];
  const seen = new Set<string>();

  for (const s of parsed.data.stocks) {
    const own: string[] = [];
    if (!STOCK_BY_SYMBOL.has(s.symbol)) own.push(`${s.symbol} is not in the allowed list.`);
    if (seen.has(s.symbol)) own.push(`${s.symbol} appears more than once.`);
    seen.add(s.symbol);

    const marketIds = [...new Set(s.marketIds)];
    for (const id of marketIds) {
      if (!byId.has(id)) own.push(`${s.symbol} cites market id ${id}, which is not in the packet.`);
    }
    if (!marketIds.length) {
      own.push(`${s.symbol} cites no market; every stock needs at least one packet market id.`);
    }
    const cited = marketIds.flatMap((id) => byId.get(id) ?? []);
    if (cited.length) {
      const actual = cited.map((m) => `${formatOdds(m.probability)}% Yes (id ${m.id})`).join(", ");
      const percents = quotedPercents(s.reason);
      const odds = percents.filter((v) => cited.some((m) => matchesOdds(v, m.probability)));
      // A percentage that is part of a cited question ("…raise tariffs to 25%?") is a quote, not odds.
      const inQuestion = (v: number) => cited.some((m) => quotedPercents(m.question).includes(v));
      if (!odds.length) {
        own.push(`${s.symbol}: the reason must quote the odds of a cited market (${actual}).`);
      }
      for (const value of percents) {
        if (!odds.includes(value) && !inQuestion(value)) {
          own.push(
            `${s.symbol}: the reason says ${value}% but its cited markets are at ${actual}.`,
          );
        }
      }
      for (const points of quotedPoints(s.reason)) {
        if (!cited.some((m) => matchesMove(points, m))) {
          own.push(
            `${s.symbol}: the reason mentions a move of ${points} points that its cited markets do not show.`,
          );
        }
      }
    }
    if (own.length) errors.push(...own);
    else stocks.push({ symbol: s.symbol, marketIds, reason: s.reason });
  }

  const count = parsed.data.stocks.length;
  if (count < MIN_STOCKS || count > MAX_STOCKS) {
    errors.push(`Pick ${MIN_STOCKS} to ${MAX_STOCKS} stocks; the answer has ${count}.`);
  }
  const summaryOk = quotedPercents(parsed.data.summary).length === 0;
  if (!summaryOk) errors.push("The summary must not contain percentages.");

  return {
    errors,
    summary: summaryOk ? parsed.data.summary : null,
    stocks: stocks.slice(0, MAX_STOCKS),
  };
}

/**
 * Numbers in a reason that nothing in the evidence backs: not quoted odds, not a quoted move,
 * and not found in the cited markets' text or the company's name. Used by the eval
 * ("is every claim grounded"); stricter than the checker.
 */
export function ungroundedNumbers(stock: DecidedStock, packet: EvidencePacket): string[] {
  const cited = packet.markets.filter((m) => stock.marketIds.includes(m.id));
  const quoted = new Set([...quotedPercents(stock.reason), ...quotedPoints(stock.reason)]);
  // "150,000" and "150000" are the same number; the windows "24 hours" and "7 days" are the packet's own.
  const plain = (text: string) => text.replace(/(\d),(?=\d{3})/g, "$1");
  const evidence = plain(
    cited.map((m) => `${m.question} ${m.analystNote}`).join(" ") +
      ` ${stock.symbol} ${STOCK_BY_SYMBOL.get(stock.symbol)?.name ?? ""}`,
  );
  const reason = plain(stock.reason).replace(/\b(24[- ]?hours?|7[- ]?days?)\b/gi, "");
  return [...reason.matchAll(/\d+(?:[.,]\d+)?/g)]
    .map((m) => m[0])
    .filter((n) => !quoted.has(Number(n.replace(",", "."))) && !evidence.includes(n));
}

const REVIEW_SYSTEM = `You review a stock selection written from Polymarket evidence. For each stock, read its reason and the markets it cites. Report a problem only when the reason states something the cited markets do not support, misreads what a market is about, or the link to the company is clearly wrong. Numbers were already checked; do not comment on style. Return an empty list when everything is supported.`;

const REVIEW_JSON_SCHEMA = {
  type: "object",
  properties: {
    issues: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        properties: { symbol: { type: "string" }, problem: { type: "string" } },
        required: ["symbol", "problem"],
      },
    },
  },
  required: ["issues"],
};

const reviewSchema = z.object({
  issues: z.array(z.object({ symbol: z.string(), problem: z.string().trim().min(1).max(300) })),
});

/** The optional LLM review (CHECKER_LLM=true): one call on the lighter model. Returns errors for the decider. */
export async function llmReview(
  idea: string,
  packet: EvidencePacket,
  stocks: DecidedStock[],
  generate: GenerateJson,
  signal?: AbortSignal,
): Promise<string[]> {
  const byId = new Map(packet.markets.map((m) => [m.id, m]));
  const lines = stocks.map((s) => {
    const cited = s.marketIds
      .flatMap((id) => byId.get(id) ?? [])
      .map((m) => `"${m.question}" (Yes ${formatOdds(m.probability)}%)`)
      .join("; ");
    return `- ${s.symbol} (${STOCK_BY_SYMBOL.get(s.symbol)?.name}): ${s.reason}\n  Cited: ${cited}`;
  });
  const raw = await generate({
    system: REVIEW_SYSTEM,
    prompt: `User's idea: ${idea}\n\nSelection:\n${lines.join("\n")}`,
    schema: REVIEW_JSON_SCHEMA,
    timeoutMs: 6000,
    thinking: ThinkingLevel.MINIMAL,
    prefer: "lite",
    fallback: false,
    signal,
  });
  return reviewSchema.parse(raw).issues.map((i) => `${i.symbol}: ${i.problem}`);
}
