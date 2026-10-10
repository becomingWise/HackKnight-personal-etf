// Track-record statistics. The scoring itself is SQL (repo.ts); this turns scored calls into
// "n, correct, %, 90% range, Brier score" for each agent, the majority and the baselines.

/** One scored call: the day it was made, whether it was right, and the probability given for "beats SPY". */
export type ScoredCall = {
  day: string;
  correct: boolean;
  /** Probability of "the basket beats SPY"; null when there is none (then no Brier score). */
  probability: number | null;
  /** What happened: did the basket beat SPY? */
  beat: boolean;
};

export type Record90 = {
  /** Scored calls. Every percentage is out of this many. */
  n: number;
  correct: number;
  /** correct / n in percent, one decimal; null when n is 0. */
  pct: number | null;
  /** 90% range of pct, from resampling whole days; null when there are fewer than 2 days. */
  range90: [number, number] | null;
  /** Mean squared error of the probability (0 is perfect, 0.25 is a coin flip); null without probabilities. */
  brier: number | null;
  /** Different days the calls were made on (the Fridays that are resampled). */
  days: number;
};

export const RESAMPLES = 2000;
const round1 = (value: number) => Math.round(value * 10) / 10;
const round3 = (value: number) => Math.round(value * 1000) / 1000;

/** A small seeded generator, so the same record always shows the same range. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The 90% range of the share of correct calls. Whole days are resampled with replacement, not
 * single calls: baskets judged in the same week move together, so they are not independent.
 */
export function range90ByDay(
  calls: Pick<ScoredCall, "day" | "correct">[],
  resamples = RESAMPLES,
  seed = 20261010,
): [number, number] | null {
  const byDay = new Map<string, { n: number; correct: number }>();
  for (const call of calls) {
    const day = byDay.get(call.day) ?? { n: 0, correct: 0 };
    byDay.set(call.day, { n: day.n + 1, correct: day.correct + (call.correct ? 1 : 0) });
  }
  const days = [...byDay.values()];
  if (days.length < 2) return null;
  const random = mulberry32(seed);
  const shares: number[] = [];
  for (let i = 0; i < resamples; i++) {
    let n = 0;
    let correct = 0;
    for (let d = 0; d < days.length; d++) {
      const pick = days[Math.floor(random() * days.length)];
      n += pick.n;
      correct += pick.correct;
    }
    shares.push((correct / n) * 100);
  }
  shares.sort((a, b) => a - b);
  const at = (q: number) => shares[Math.min(shares.length - 1, Math.floor(q * shares.length))];
  return [round1(at(0.05)), round1(at(0.95))];
}

export function summarizeCalls(calls: ScoredCall[]): Record90 {
  const n = calls.length;
  const correct = calls.filter((call) => call.correct).length;
  const withProbability = calls.filter((call) => call.probability !== null);
  return {
    n,
    correct,
    pct: n ? round1((correct / n) * 100) : null,
    range90: range90ByDay(calls),
    brier: withProbability.length
      ? round3(
          withProbability.reduce(
            (sum, call) => sum + (call.probability! - (call.beat ? 1 : 0)) ** 2,
            0,
          ) / withProbability.length,
        )
      : null,
    days: new Set(calls.map((call) => call.day)).size,
  };
}
