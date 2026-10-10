// Turns one panel result into the row that is saved for the track record. The live endpoint and
// the replay both use it, so the two kinds of decisions are stored alike.
import {
  VOTERS,
  majorityOf,
  type BasketInput,
  type PanelContext,
  type VoterAnswer,
} from "../votes/votes";
import { BENCHMARK } from "./closes";
import type { DecisionSource, DecisionVote, NewDecision } from "./repo";

/** A linked Polymarket signal as it stood when the panel decided. */
export type SignalInput = {
  id: string;
  label: string;
  probability: number;
  change7d: number | null;
};

export function decisionOf(input: {
  source: DecisionSource;
  basket: BasketInput;
  context: PanelContext;
  signals: SignalInput[];
  /** One per voter, in VOTERS order; null when that voter gave no answer. */
  answers: (VoterAnswer | null)[];
  models?: (string | null)[];
}): NewDecision | null {
  // Without a close there is no day to score from.
  if (!input.context.asOf) return null;
  const votes: DecisionVote[] = VOTERS.flatMap((voter, index) => {
    const call = input.answers[index]?.call;
    return call
      ? [
          {
            agent: voter.id,
            vote: call.vote,
            probability: call.probability,
            reason: call.reason,
            model: input.models?.[index] ?? null,
          },
        ]
      : [];
  });
  if (!votes.length) return null;
  return {
    day: input.context.asOf,
    source: input.source,
    idea: input.basket.idea,
    symbols: input.basket.stocks.map((stock) => stock.symbol),
    inputs: {
      signals: input.signals,
      returns: { [BENCHMARK]: input.context.spy, ...input.basket.returns },
    },
    majority: majorityOf(
      votes.filter((vote) => vote.vote === "yes").length,
      votes.filter((vote) => vote.vote === "no").length,
    ),
    votes,
  };
}
