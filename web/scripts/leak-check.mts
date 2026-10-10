// Leak check before the track-record replay: do the voters' models know anything from inside the
// replay window? One question, asked of each Flash-Lite model once (answers are stored, so a
// second run costs nothing):
//   pnpm track:leak-check
// The right answer comes from our own stock_closes table.
import { db } from "../src/lib/db/client";
import { geminiGenerateJson, ThinkingLevel } from "../src/lib/sponsors/gemini";
import { createCachedCalls, tigerCallStore } from "../src/lib/track/replayCalls";

const DAY = "2026-10-02";
const [truth] = await db()<{ close: number }[]>`
  select close from stock_closes where symbol = 'SPY' and day = ${DAY}`;

const calls = createCachedCalls({
  generate: geminiGenerateJson,
  store: tigerCallStore,
  limit: 2,
  paceMs: 5_000,
});
const question = {
  system:
    "Answer only from what you know. Do not guess: when you do not know a figure, say so in the note and set it to null.",
  prompt:
    `1. What was the closing price of the SPDR S&P 500 ETF (SPY) on Friday, ${DAY}?\n` +
    "2. What is the most recent month and year you have reliable knowledge of?\n" +
    "3. What is the latest SPY closing price you are confident about, and on which date?",
  schema: {
    type: "object",
    properties: {
      spyCloseOnDay: { type: ["number", "null"] },
      latestKnowledge: { type: "string", description: "Month and year, e.g. March 2025." },
      latestSpyClose: { type: ["number", "null"] },
      latestSpyCloseDate: { type: ["string", "null"] },
      note: { type: "string" },
    },
    required: ["spyCloseOnDay", "latestKnowledge", "latestSpyClose", "latestSpyCloseDate", "note"],
  },
  timeoutMs: 20_000,
  thinking: ThinkingLevel.MINIMAL,
};

console.log(`Truth: SPY closed at ${truth?.close.toFixed(2)} on ${DAY}.`);
// voteA starts on gemini-3.5-flash-lite, voteB on gemini-3.1-flash-lite: the voters' two chains.
for (const task of ["voteA", "voteB"] as const) {
  const answer = await calls.ask(`leak-check ${task}`, { ...question, task });
  console.log(
    `${answer.model}${answer.cached ? " (stored)" : ""}:`,
    JSON.stringify(answer.response),
  );
}
console.log(`New Gemini calls: ${calls.made()}`);
await db().end();
