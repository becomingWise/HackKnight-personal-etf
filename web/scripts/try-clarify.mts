// Live check of "ask instead of answering" (the stock agent's clarify path), on Flash-Lite:
//   pnpm try:clarify            the 14 fixed inputs, then the first option of each question
//   pnpm try:clarify --max 20   Gemini requests allowed in this run (default 20)
// It runs the same agent as POST /api/stocks with the live Polymarket signals and the shared
// model budgets, but with its own empty cache and memory, so every input is really decided.
// It stops before going over the limit and says what was left undone.
import { ClarifyError, createFindStocks } from "../src/lib/agent-core/agent/gemini.js";
import { createMemoryStore } from "../src/lib/agent-core/agent/memory.js";
import { looksLikeNonsense } from "../src/lib/agent-core/agent/precheck.js";
import { agentBudget } from "../src/lib/agentApi/adapters";
import { db } from "../src/lib/db/client";
import { geminiBudget } from "../src/lib/sponsors/gemini";
import { liveSignals } from "../src/lib/weights/signals";

const CLEAR = ["AI chips and Taiwan risk", "TSM", "oil", "banks", "我想投资AI芯片"];
const UNCLEAR = [
  "car",
  "food",
  "airlines",
  "money",
  "asdfgh",
  "banana dance",
  "hello",
  "what's the weather?",
  "???",
];

const maxAt = process.argv.indexOf("--max");
const limit = maxAt > 0 ? Number(process.argv[maxAt + 1]) : 20;
// A basket normally takes two requests; the run never starts one it could not finish.
const BASKET_CALLS = 2;

let sent = 0;
const shared = agentBudget(geminiBudget);
const budget = {
  ...shared,
  // Every request really sent to Gemini passes here first: counted, and refused at the limit.
  async reserve(model: string, purpose: string) {
    if (sent >= limit) return "the check's own limit";
    const refusal = await shared.reserve(model, purpose);
    if (!refusal) sent += 1;
    return refusal;
  },
};
const memory = createMemoryStore();
const findStocks = createFindStocks({ memory, budget, sessionId: "clarify-check" }) as (
  input: { idea: string },
  options: { signals?: unknown[] },
) => Promise<{ summary: string; stocks: { symbol: string }[] }>;
const signals = await liveSignals();
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type Outcome =
  | { kind: "basket"; symbols: string[]; calls: number }
  | { kind: "clarify"; question: string; options: string[]; calls: number }
  | { kind: "error"; message: string; calls: number };

async function ask(idea: string): Promise<Outcome> {
  const before = sent;
  try {
    const result = await findStocks({ idea }, { signals });
    return { kind: "basket", symbols: result.stocks.map((s) => s.symbol), calls: sent - before };
  } catch (err) {
    if (err instanceof ClarifyError) {
      return {
        kind: "clarify",
        question: err.message,
        options: (err as unknown as { options: string[] }).options,
        calls: sent - before,
      };
    }
    return { kind: "error", message: String(err).slice(0, 160), calls: sent - before };
  } finally {
    // At most about eight requests a minute.
    if (sent > before) await sleep(7_000);
  }
}

const show = (idea: string, outcome: Outcome) =>
  console.log(
    `${JSON.stringify(idea)} -> ` +
      (outcome.kind === "basket"
        ? `BASKET ${outcome.symbols.join(", ")}`
        : outcome.kind === "clarify"
          ? `ASK "${outcome.question}" ${JSON.stringify(outcome.options)}`
          : `ERROR ${outcome.message}`) +
      `  [${outcome.calls} calls]`,
  );

const questions: { idea: string; options: string[] }[] = [];
let clearStopped = 0;
let unclearBasket = 0;
let skipped = 0;

console.log(`Limit: ${limit} Gemini requests.\n--- clear ideas (a basket is expected) ---`);
for (const idea of CLEAR) {
  if (limit - sent < BASKET_CALLS) {
    skipped += 1;
    console.log(`${JSON.stringify(idea)} -> NOT RUN (limit)`);
    continue;
  }
  const outcome = await ask(idea);
  show(idea, outcome);
  if (outcome.kind !== "basket") clearStopped += 1;
  if (outcome.kind === "clarify") questions.push({ idea, options: outcome.options });
}
console.log("--- broad, not covered, nonsense or off-topic (a question is expected) ---");
for (const idea of UNCLEAR) {
  // What the free pre-check stops needs no request, so the limit does not apply to it.
  if (limit - sent < 1 && !looksLikeNonsense(idea)) {
    skipped += 1;
    console.log(`${JSON.stringify(idea)} -> NOT RUN (limit)`);
    continue;
  }
  const outcome = await ask(idea);
  show(idea, outcome);
  if (outcome.kind === "basket") unclearBasket += 1;
  if (outcome.kind === "clarify") questions.push({ idea, options: outcome.options });
}

console.log("--- the first option of each question, submitted as the idea ---");
const tried = new Map<string, Outcome>();
let optionsOk = 0;
let optionsFailed = 0;
let optionsNotRun = 0;
for (const { idea, options } of questions) {
  const option = options[0];
  let outcome = tried.get(option);
  if (!outcome) {
    if (limit - sent < BASKET_CALLS) {
      optionsNotRun += 1;
      console.log(`${JSON.stringify(idea)} => ${JSON.stringify(option)} -> NOT RUN (limit)`);
      continue;
    }
    outcome = await ask(option);
    tried.set(option, outcome);
  }
  show(`${idea} => ${option}`, outcome);
  if (outcome.kind === "basket") optionsOk += 1;
  else optionsFailed += 1;
}

const remembered = await memory.load("clarify-check");
console.log(
  `\nGemini requests sent: ${sent} of ${limit}.` +
    `\nClear ideas wrongly stopped: ${clearStopped} of ${CLEAR.length} (target 0).` +
    `\nOther inputs that got a basket anyway: ${unclearBasket} of ${UNCLEAR.length} (target 0).` +
    `\nFirst options: ${optionsOk} gave a basket, ${optionsFailed} did not, ${optionsNotRun} not run (limit).` +
    (skipped ? `\nInputs not run (limit): ${skipped}.` : "") +
    `\nBaskets saved to memory: ${remembered.baskets.length} (questions save nothing).`,
);
await db().end();
