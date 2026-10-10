// The track-record replay (src/lib/track/replay.ts):
//   pnpm track:replay            run it (stored answers are reused; new Gemini calls are capped)
//   pnpm track:replay --plan     show the baskets, Fridays and the first prompt; no Gemini call
//   pnpm track:replay --picks    make the stock agent's picks only, then show the same plan
// Steps: 1. the stock agent picks one basket per idea, once, with the live-odds context and web
// search switched off (so nothing from today leaks into an August basket); 2. the Polymarket
// price history of the tracked signals is fetched once; 3. five agents vote on every basket for
// each Friday; 4. SQL scores each decision against the next Friday's closes.
// Everything fetched or answered is stored in replay_calls: a second run costs no Gemini call.
// Flash-Lite only. The total over all runs is capped at REPLAY_CALL_CAP requests.
import { createFindStocks } from "../src/lib/agent-core/agent/gemini.js";
import { createMemoryStore } from "../src/lib/agent-core/agent/memory.js";
import { agentBudget } from "../src/lib/agentApi/adapters";
import { db } from "../src/lib/db/client";
import { parseHistory } from "../src/lib/polymarket/markets";
import { geminiBudget, geminiGenerateJson } from "../src/lib/sponsors/gemini";
import {
  LAST_REPLAY_FRIDAY,
  REPLAY_FRIDAYS_COUNT,
  REPLAY_IDEAS,
  fridaysEnding,
  replayVoteKey,
  runReplay,
  signalAsOf,
  type Basket,
  type OddsHistory,
} from "../src/lib/track/replay";
import {
  CallLimitError,
  createCachedCalls,
  namedKey,
  tigerCallStore,
} from "../src/lib/track/replayCalls";
import { pastCalls, priceInputs, saveDecision, scoreDueDecisions } from "../src/lib/track/repo";
import { polymarketEvidence } from "../src/lib/votes/handler";
import { VOTERS, voterRequest } from "../src/lib/votes/votes";
import { liveSignals } from "../src/lib/weights/signals";

/** Lucas's limit for the whole replay, over every run, the leak check included. */
const REPLAY_CALL_CAP = 80;
/** Seconds between two new Gemini calls: at most 9 a minute, split over the two Flash-Lite models. */
const PACE_MS = 7_000;
const AGENT_WORST_CASE = 4;

const planOnly = process.argv.includes("--plan");
const picksOnly = process.argv.includes("--picks");
const store = tigerCallStore;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fridays = fridaysEnding(LAST_REPLAY_FRIDAY, REPLAY_FRIDAYS_COUNT);
const voterCalls = fridays.length * VOTERS.length;

const spentBefore = await store.spent();
const calls = createCachedCalls({
  generate: geminiGenerateJson,
  store,
  limit: planOnly ? 0 : Math.max(0, REPLAY_CALL_CAP - spentBefore),
  paceMs: PACE_MS,
});
console.log(
  `Gemini calls spent by the replay so far: ${spentBefore} of ${REPLAY_CALL_CAP}. Fridays: ${fridays.join(", ")}`,
);

try {
  // ---- 1. Baskets: the stock agent's pick per idea, made once and saved ----
  let agentCalls = 0;
  const findStocks = createFindStocks({
    memory: createMemoryStore(),
    budget: agentBudget(geminiBudget),
    sessionId: null,
    // No web search: it would read today's news.
    search: false,
    log: (event: { event?: string }) => {
      if (event.event === "model_call" || event.event === "model_failed") agentCalls += 1;
    },
  }) as (input: { idea: string }) => Promise<{ summary: string; stocks: Basket["stocks"] }>;

  const baskets: Basket[] = [];
  for (const idea of REPLAY_IDEAS) {
    const key = namedKey("pick:v1", idea);
    let pick = (await store.get(key))?.response as Basket | undefined;
    if (!pick) {
      if (planOnly) {
        console.log(`pick needed: "${idea}"`);
        continue;
      }
      // The votes still to come are set aside first; a pick may take up to four calls.
      const votesToCome = await votesStillNeeded();
      if (calls.remaining() - votesToCome < AGENT_WORST_CASE)
        throw new CallLimitError(REPLAY_CALL_CAP);
      if (calls.made() > 0) await sleep(PACE_MS);
      agentCalls = 0;
      try {
        // No `signals` option: the pick is made without the live Polymarket context.
        const selection = await findStocks({ idea });
        pick = { idea, stocks: selection.stocks };
      } finally {
        await calls.spend(agentCalls);
      }
      await store.set(key, `pick: ${idea}`, { model: "stock agent (Flash-Lite)", response: pick });
      console.log(
        `picked (${agentCalls} calls): ${idea} -> ${pick.stocks.map((s) => s.symbol).join(", ")}`,
      );
    }
    baskets.push(pick);
  }

  // ---- 2. Odds history of the tracked signals (Data API v2), fetched once ----
  const histories: OddsHistory[] = [];
  const historyKey = namedKey("odds-history:v1", LAST_REPLAY_FRIDAY);
  const storedHistory = (await store.get(historyKey))?.response as OddsHistory[] | undefined;
  if (storedHistory) {
    histories.push(...storedHistory);
  } else {
    for (const signal of await liveSignals()) {
      const token = signal.tokenIds?.[0];
      if (signal.status !== "live" || !token) continue;
      const url = new URL("https://data-api.polymarket.com/v2/prices-history");
      url.searchParams.set("token_id", token);
      url.searchParams.set("interval", "max");
      url.searchParams.set("bucket_seconds", "43200");
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      if (!response.ok) throw new Error(`prices-history ${signal.id}: HTTP ${response.status}`);
      histories.push({
        id: signal.id,
        label: signal.label,
        question: signal.question ?? signal.label,
        betas: signal.betas,
        points: parseHistory(await response.json()).points.map((p) => [
          p.time.getTime(),
          p.probability,
        ]),
      });
    }
    await store.set(historyKey, "Polymarket odds history of the tracked signals", {
      model: "polymarket data api v2",
      response: histories,
    });
  }
  for (const friday of fridays) {
    const known = histories.flatMap((h) => (signalAsOf(h, friday) ? [h.id] : []));
    console.log(
      `${friday}: ${known.length} of ${histories.length} markets existed (${known.join(", ")})`,
    );
  }

  async function votesStillNeeded(): Promise<number> {
    // Counted from what is stored; an unknown basket set means none of the votes exist yet.
    if (baskets.length < REPLAY_IDEAS.length) return voterCalls;
    let missing = 0;
    for (const friday of fridays) {
      for (const voter of VOTERS) {
        if (!(await store.get(replayVoteKey(friday, voter.id, baskets)))) missing += 1;
      }
    }
    return missing;
  }

  if (planOnly || picksOnly) {
    if (baskets.length) {
      const friday = fridays[0];
      const prices = await priceInputs(
        baskets.flatMap((b) => b.stocks.map((s) => s.symbol)),
        friday,
      );
      const signals = histories.flatMap((h) => signalAsOf(h, friday) ?? []);
      const shown = baskets.slice(0, 2).map((basket) => ({
        ...basket,
        evidence: polymarketEvidence(
          basket.idea,
          basket.stocks.map((s) => s.symbol),
          signals,
          new Date(`${friday}T20:00:00Z`),
        ),
        returns: prices.returns,
      }));
      console.log(`\nPrompt of "${VOTERS[2].agent}" for ${friday} (first two baskets):\n`);
      console.log(voterRequest(2, shown, { asOf: prices.asOf, spy: prices.spy }).prompt);
    }
    console.log(`\nVotes still needed: ${await votesStillNeeded()} calls.`);
  } else {
    // ---- 3 and 4. The agents vote Friday by Friday; SQL scores each week ----
    const result = await runReplay({
      baskets,
      fridays,
      histories,
      calls,
      prices: priceInputs,
      past: (scoredOnOrBefore) => pastCalls({ scoredOnOrBefore, source: "replay" }),
      save: (decision) => saveDecision(decision, { replace: true }),
      score: scoreDueDecisions,
      log: (line) => console.log(line),
    });
    console.log(
      `Replay done: ${result.decisions} decisions on ${result.fridays} Fridays, ` +
        `${result.missingAnswers} agent answers missing (run again to retry them).`,
    );
  }
} catch (err) {
  if (!(err instanceof CallLimitError)) throw err;
  console.error(
    `STOPPED: the replay would go over ${REPLAY_CALL_CAP} Gemini calls. Ask Lucas before spending more.`,
  );
  process.exitCode = 2;
} finally {
  console.log(
    `New Gemini calls in this run: ${calls.made()}. Total so far: ${await store.spent()} of ${REPLAY_CALL_CAP}.`,
  );
  await db().end();
}
