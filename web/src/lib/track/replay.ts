// The replay behind the panel's track record: the same five agents, prompts and models as
// POST /api/votes, asked on past Fridays with only what was known that day (closes up to that
// Friday, Polymarket odds as of its close), then scored against the next Friday.
// One Gemini call per agent per Friday, with every basket in it.
import { DEMO_IDEAS } from "../demo/warm";
import { polymarketEvidence } from "../votes/handler";
import {
  VOTERS,
  readAnswer,
  voterRequest,
  type BasketInput,
  type PastCalls,
  type Stock,
  type VoterAnswer,
} from "../votes/votes";
import type { Signal } from "../weights/engine";
import { decisionOf } from "./decision";
import { CallLimitError, namedKey, type CachedCalls } from "./replayCalls";
import type { NewDecision, PriceInputs } from "./repo";

/** The four demo ideas plus one per remaining sector, so all seven sectors are covered. */
export const REPLAY_IDEAS = [
  ...DEMO_IDEAS,
  "Big Tech and the AI build-out",
  "Defense spending and geopolitical tension",
  "Big banks and interest rates",
  "Oil majors and Middle East supply risk",
  "Bitcoin and crypto adoption",
  "Bonds as a safe haven if the economy slows",
] as const;

export const LAST_REPLAY_FRIDAY = "2026-10-02";
export const REPLAY_FRIDAYS_COUNT = 8;
/** A replay call answers for ten baskets at once, so it gets more time than a live one. */
const REPLAY_TIMEOUT_MS = 45_000;
const DAY_MS = 86_400_000;

/** `count` Fridays ending with `last` (YYYY-MM-DD), oldest first. */
export function fridaysEnding(last: string, count: number): string[] {
  const end = Date.parse(`${last}T00:00:00Z`);
  if (new Date(end).getUTCDay() !== 5) throw new Error(`${last} is not a Friday.`);
  return Array.from({ length: count }, (_, i) =>
    new Date(end - (count - 1 - i) * 7 * DAY_MS).toISOString().slice(0, 10),
  );
}

export type Basket = { idea: string; stocks: Stock[] };

/** A tracked signal's market with its whole price history ([time in ms, Yes price]). */
export type OddsHistory = {
  id: string;
  label: string;
  question: string;
  betas: Record<string, number>;
  points: [number, number][];
};

/** A price older than this is not "the odds that day": the market was not trading yet. */
const STALE_MS = 3 * DAY_MS;

/**
 * The signal as it stood at the US market close of `day` (20:00 UTC): the last price up to that
 * moment and the change against a week earlier. Null when the market did not exist then.
 */
export function signalAsOf(history: OddsHistory, day: string): Signal | null {
  const close = Date.parse(`${day}T20:00:00Z`);
  const lastUpTo = (time: number) => {
    let found: [number, number] | null = null;
    for (const point of history.points) {
      if (point[0] <= time && (!found || point[0] > found[0])) found = point;
    }
    return found && time - found[0] <= STALE_MS ? found[1] : null;
  };
  const price = lastUpTo(close);
  if (price === null || !(price > 0 && price < 1)) return null;
  const weekAgo = lastUpTo(close - 7 * DAY_MS);
  return {
    id: history.id,
    label: history.label,
    question: history.question,
    betas: history.betas,
    status: "live",
    price,
    changes: { "1w": weekAgo === null ? null : price - weekAgo },
  };
}

/**
 * Where one agent's answer for one Friday is stored. The key names the Friday, the agent and the
 * baskets, not the prompt text: adjusted closes shift a little when they are reloaded, and that
 * must not turn a stored answer into a new call.
 */
export const replayVoteKey = (friday: string, voterId: string, baskets: Basket[]) =>
  namedKey(
    "replay:v1",
    friday,
    voterId,
    ...baskets.map((b) => [b.idea, ...b.stocks.map((s) => s.symbol)].join("|")),
  );

export type ReplayDeps = {
  baskets: Basket[];
  fridays: string[];
  histories: OddsHistory[];
  calls: CachedCalls;
  /** Returns as of the last close on or before the day; nothing later is read. */
  prices: (symbols: string[], onOrBefore: string) => Promise<PriceInputs>;
  /** Each agent's replay calls that were already scored by that day. */
  past: (scoredOnOrBefore: string) => Promise<Record<string, PastCalls>>;
  save: (decision: NewDecision) => Promise<unknown>;
  /** Scores what is due (SQL), so the next Friday's agents can be told their record so far. */
  score: () => Promise<number>;
  log?: (line: string) => void;
};

export type ReplayResult = { fridays: number; decisions: number; missingAnswers: number };

export async function runReplay(deps: ReplayDeps): Promise<ReplayResult> {
  const symbols = [...new Set(deps.baskets.flatMap((b) => b.stocks.map((s) => s.symbol)))];
  let decisions = 0;
  let missingAnswers = 0;

  for (const friday of deps.fridays) {
    const signals = deps.histories.flatMap((history) => signalAsOf(history, friday) ?? []);
    const prices = await deps.prices(symbols, friday);
    const context = { asOf: prices.asOf, spy: prices.spy };
    const inputs: BasketInput[] = deps.baskets.map((basket) => {
      const held = basket.stocks.map((s) => s.symbol);
      return {
        idea: basket.idea,
        stocks: basket.stocks,
        evidence: polymarketEvidence(basket.idea, held, signals, new Date(`${friday}T20:00:00Z`)),
        returns: Object.fromEntries(held.map((symbol) => [symbol, prices.returns[symbol]])),
      };
    });
    // What an agent is told about itself: only calls whose week had ended by this Friday.
    const past = await deps.past(friday);

    const answers: (VoterAnswer[] | null)[] = [];
    const models: (string | null)[] = [];
    for (const [index, voter] of VOTERS.entries()) {
      try {
        const stored = await deps.calls.ask(
          `replay ${friday} ${voter.id}`,
          { ...voterRequest(index, inputs, context, past[voter.id]), timeoutMs: REPLAY_TIMEOUT_MS },
          replayVoteKey(friday, voter.id, deps.baskets),
        );
        answers.push(readAnswer(stored.response, inputs));
        models.push(stored.model);
        deps.log?.(`${friday} ${voter.id}: ${stored.cached ? "stored" : stored.model}`);
      } catch (err) {
        if (err instanceof CallLimitError) throw err;
        answers.push(null);
        models.push(null);
        missingAnswers += 1;
        deps.log?.(`${friday} ${voter.id}: no answer (${String(err).slice(0, 100)})`);
      }
    }

    for (const [at, basket] of inputs.entries()) {
      const held = basket.stocks.map((s) => s.symbol);
      const decision = decisionOf({
        source: "replay",
        basket,
        context,
        signals: signals
          .filter((s) => held.some((symbol) => symbol in s.betas))
          .map((s) => ({
            id: s.id,
            label: s.label,
            probability: s.price!,
            change7d: s.changes?.["1w"] ?? null,
          })),
        answers: answers.map((perBasket) => perBasket?.[at] ?? null),
        models,
      });
      if (decision) {
        await deps.save(decision);
        decisions += 1;
      }
    }
    await deps.score();
  }
  return { fridays: deps.fridays.length, decisions, missingAnswers };
}
