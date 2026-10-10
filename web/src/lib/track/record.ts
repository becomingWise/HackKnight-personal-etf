// GET /api/track-record: how often each agent of the voting panel, and its majority, was right
// about "will this basket beat SPY over the next week?". Contract: docs/API.md section 1f.
import { preflight } from "../http/cors";
import { error, json } from "../http/respond";
import { VOTERS, type PastCalls } from "../votes/votes";
import {
  pastCalls,
  recentDecisions,
  scoredRows,
  type RecentDecision,
  type ScoredDecisionRow,
  type ScoredVoteRow,
} from "./repo";
import { summarizeCalls, type Record90 } from "./stats";

export type TrackRecord = {
  generatedAt: string;
  question: string;
  /** The last close loaded; a decision is scored once a close a week after it exists. */
  lastClose: string | null;
  /** Scored decisions (baskets judged), and the ones still waiting for their week to pass. */
  decisions: number;
  pending: number;
  agents: ({ id: string; agent: string } & Record90)[];
  /** 3 or more of the 5 agents. Its probability is the mean of the agents' probabilities. */
  majority: Record90;
  baselines: {
    /** Saying "yes, it beats SPY" every time. */
    alwaysYes: Record90;
    /** A fair coin: 50% right and a Brier score of 0.25 by definition. */
    coinFlip: { n: number; pct: 50; brier: 0.25 };
  };
  /** The last 20 decisions, newest first; the outcome fields are null until scored. */
  recent: RecentDecision[];
};

export function buildTrackRecord(
  rows: {
    votes: ScoredVoteRow[];
    decisions: ScoredDecisionRow[];
    pending: number;
    lastClose: string | null;
  },
  recent: RecentDecision[],
  now: Date,
): TrackRecord {
  const meanProbability = new Map<string, number>();
  for (const decision of rows.decisions) {
    const given = rows.votes.filter((vote) => vote.decisionId === decision.decisionId);
    if (given.length) {
      meanProbability.set(
        decision.decisionId,
        given.reduce((sum, vote) => sum + vote.probability, 0) / given.length,
      );
    }
  }
  return {
    generatedAt: now.toISOString(),
    question: "Will this basket (equal weights) beat SPY over the next week?",
    lastClose: rows.lastClose,
    decisions: rows.decisions.length,
    pending: rows.pending,
    agents: VOTERS.map((voter) => ({
      id: voter.id,
      agent: voter.agent,
      ...summarizeCalls(rows.votes.filter((vote) => vote.agent === voter.id)),
    })),
    majority: summarizeCalls(
      rows.decisions
        .filter((decision) => decision.majorityCorrect !== null)
        .map((decision) => ({
          day: decision.day,
          correct: decision.majorityCorrect!,
          probability: meanProbability.get(decision.decisionId) ?? null,
          beat: decision.beat,
        })),
    ),
    baselines: {
      alwaysYes: summarizeCalls(
        rows.decisions.map((decision) => ({
          day: decision.day,
          correct: decision.beat,
          probability: 1,
          beat: decision.beat,
        })),
      ),
      coinFlip: { n: rows.decisions.length, pct: 50, brier: 0.25 },
    },
    recent,
  };
}

export type TrackDeps = {
  load: () => Promise<TrackRecord>;
};

export const defaultTrackDeps: TrackDeps = {
  load: async () => buildTrackRecord(await scoredRows(), await recentDecisions(20), new Date()),
};

export function createTrackRecordHandler(deps: TrackDeps = defaultTrackDeps) {
  async function GET(request: Request): Promise<Response> {
    try {
      return json(request, 200, await deps.load());
    } catch (err) {
      console.log(
        JSON.stringify({ at: "track-record", event: "error", message: String(err).slice(0, 200) }),
      );
      return error(request, 503, "storage_error", "The track record is unavailable. Try again.");
    }
  }
  return { GET, OPTIONS: (request: Request): Response => preflight(request) };
}

const RECORDS_TTL_MS = 5 * 60_000;
let cachedPast: { expires: number; value: Promise<Record<string, PastCalls>> } | undefined;

/** Every agent's scored calls (replay and live), read at most every five minutes per instance. */
export function livePastCalls(): Promise<Record<string, PastCalls>> {
  if (cachedPast && cachedPast.expires > Date.now()) return cachedPast.value;
  const value = pastCalls();
  cachedPast = { expires: Date.now() + RECORDS_TTL_MS, value };
  value.catch(() => {
    if (cachedPast?.value === value) cachedPast = undefined;
  });
  return value;
}
