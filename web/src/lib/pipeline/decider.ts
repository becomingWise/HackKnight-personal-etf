// Stage c, the DECIDER: one Gemini call that turns the idea and the evidence packet into 3 to 5
// stocks with reasons. This file is the prompt; run `pnpm eval:decider` before and after changing it.
import { formatPoints } from "../analyst/signals";
import type { EvidencePacket } from "../analyst/packet";
import { MAX_STOCKS, MIN_STOCKS, formatOdds } from "../stocks/contract";
import { SECTORS, STOCK_BY_SYMBOL, SYMBOLS } from "../stocks/universe";

export const DECIDER_SYSTEM = `You are the decider of a personal-ETF app. An analyst has already collected live Polymarket prediction markets for the user's idea and analyzed them into an evidence packet. You make the final decision: which stocks fit the idea, and why. Your answer is checked by code against the packet, so the packet is your only source of facts.

Rules:
- Pick ${MIN_STOCKS} to ${MAX_STOCKS} different stocks, ONLY from the allowed list. Prefer companies whose business is clearly exposed to the idea. The analyst's ticker signals are hints, not orders: you may pick an allowed stock without a ticker signal when a packet market clearly matters for it.
- "marketIds": for each stock, the ids of the one to three packet markets your reason relies on. Never use an id that is not in the packet. A stock you cannot tie to a packet market must not be picked.
- "reason": one or two sentences for the user. Quote the current odds of at least one cited market exactly as the packet gives them, then say why that matters for this company. Say the event in your own words as a normal clause, for example: Polymarket gives 12% that the Fed makes no rate cuts in 2026, which matters for <company> because <link>. Never paste a market question ("Will ...?") into a sentence.
- Numbers: every percentage in a reason must be the Yes odds of a market cited for that stock (or 100 minus them, when you speak about No). An odds move is written in points exactly as given ("up 1.2 pts over 7 days"), never as a percentage. Use no other numbers except those that appear in the market's question.
- "summary": two or three sentences on how the idea maps to these companies and which markets matter most. No numbers and no percentages in the summary.
- Where the evidence allows, cite different markets for different stocks instead of repeating one.
- Never mention stock prices, price targets, returns, allocation percentages or weights. Never give investment advice.
- Write summary and reasons in the same language as the user's idea. Keep ticker symbols and market questions as given.`;

export const DECISION_JSON_SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    stocks: {
      type: "array",
      minItems: MIN_STOCKS,
      maxItems: MAX_STOCKS,
      items: {
        type: "object",
        properties: {
          symbol: { type: "string", enum: SYMBOLS },
          marketIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
          reason: { type: "string" },
        },
        required: ["symbol", "marketIds", "reason"],
      },
    },
  },
  required: ["summary", "stocks"],
};

/** The analyst lists ticker signals most important first; the prompt shows this many. */
const MAX_TICKER_LINES = 20;

function stockList(): string {
  return SECTORS.map(
    (s) => `${s.name}: ${s.holdings.map((h) => `${h.symbol} (${h.name})`).join(", ")}`,
  ).join("\n");
}

function packetText(packet: EvidencePacket): string {
  const moved = (label: string, change: number | null) =>
    change === null ? "" : `, ${label} ${formatPoints(change)}`;
  const markets = packet.markets.map(
    (m) =>
      `- id ${m.id}: "${m.question}" | Yes ${formatOdds(m.probability)}%` +
      moved("24h", m.change24h) +
      moved("7d", m.change7d) +
      (m.endDate ? `, ends ${m.endDate.slice(0, 10)}` : "") +
      `, relevance ${m.relevance}, signal ${m.signal}` +
      (m.analystNote ? ` | Analyst: ${m.analystNote}` : ""),
  );
  const themes = packet.themes.map(
    (t) =>
      `- ${t.name}: ${t.direction}, confidence ${t.confidence}, markets ${t.marketIds.join(", ")}`,
  );
  const tickers = packet.tickerSignals
    .filter((t) => STOCK_BY_SYMBOL.has(t.symbol))
    .slice(0, MAX_TICKER_LINES)
    .map(
      (t) =>
        `- ${t.symbol}: impact ${t.impact > 0 ? "+" : ""}${t.impact} via ${t.marketIds.join(", ")} | ${t.why}`,
    );
  const section = (title: string, lines: string[]) =>
    `${title}\n${lines.length ? lines.join("\n") : "- none"}`;
  return [
    section('Markets (live odds for "Yes"; moves in points):', markets),
    section("Themes:", themes),
    section("Ticker signals (impact from -1 to +1):", tickers),
    section(
      "Analyst warnings:",
      packet.warnings.map((w) => `- ${w}`),
    ),
  ].join("\n\n");
}

export function deciderPrompt(idea: string, packet: EvidencePacket): string {
  return (
    `Allowed stocks (symbol and company, by sector):\n${stockList()}\n\n` +
    `Evidence packet\n\n${packetText(packet)}\n\n` +
    `User's idea: ${idea}`
  );
}

/** The one revision: the same task, the rejected answer, and exactly what the checker found. */
export function revisionPrompt(base: string, previous: unknown, errors: string[]): string {
  return (
    `${base}\n\n` +
    `Your previous answer:\n${JSON.stringify(previous)}\n\n` +
    `The checker rejected it:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n` +
    `Answer again with every point fixed. Keep what was not criticized.`
  );
}
