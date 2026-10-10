// What reusing answers saves. /api/stocks and /api/votes count every answer they serve, per
// Pacific day (the day Google counts the Gemini quota by): did it need new Gemini calls, or was
// it reused from the cache because the odds it rests on had not moved? Counting fails open.
import { db } from "../db/client";
import { periods } from "../gemini/models";

export type Endpoint = "stocks" | "votes";

export type Savings = {
  /** The Pacific day, e.g. "2026-10-10". */
  day: string;
  /** Answers served that day by /api/stocks and /api/votes. */
  answers: number;
  /** Of those, the ones that needed new Gemini calls. */
  newAnswers: number;
  /** And the ones served again from the cache. */
  reused: number;
  /** reused / answers, in percent with one decimal; 0 when nothing was served. */
  reusedPct: number;
  /** Every Gemini call the app made that day, all models (from gemini_usage). */
  geminiCalls: number;
};

export type SavingsStore = {
  /** Counts one served answer. */
  record(endpoint: Endpoint, reused: boolean, now?: Date): Promise<void>;
  read(now?: Date): Promise<Savings>;
};

export function summarize(
  dayKey: string,
  counts: { answers: number; reused: number },
  geminiCalls: number,
): Savings {
  const { answers, reused } = counts;
  return {
    day: dayKey.replace(/^d:/, ""),
    answers,
    newAnswers: answers - reused,
    reused,
    reusedPct: answers ? Math.round((reused / answers) * 1000) / 10 : 0,
    geminiCalls,
  };
}

/** In-memory store for tests; `geminiCalls` stands in for the gemini_usage table. */
export function memorySavings(geminiCalls: (dayKey: string) => number = () => 0): SavingsStore {
  const days = new Map<string, { answers: number; reused: number }>();
  return {
    async record(_endpoint, reused, now = new Date()) {
      const { day } = periods(now);
      const row = days.get(day) ?? { answers: 0, reused: 0 };
      days.set(day, { answers: row.answers + 1, reused: row.reused + (reused ? 1 : 0) });
    },
    async read(now = new Date()) {
      const { day } = periods(now);
      return summarize(day, days.get(day) ?? { answers: 0, reused: 0 }, geminiCalls(day));
    },
  };
}

export const tigerSavings: SavingsStore = {
  async record(endpoint, reused, now = new Date()) {
    try {
      const { day } = periods(now);
      const one = reused ? 1 : 0;
      await db()`
        insert into answer_stats (day, endpoint, answers, new_answers, reused)
        values (${day}, ${endpoint}, 1, ${1 - one}, ${one})
        on conflict (day, endpoint) do update set
          answers = answer_stats.answers + 1,
          new_answers = answer_stats.new_answers + excluded.new_answers,
          reused = answer_stats.reused + excluded.reused,
          updated_at = now()`;
    } catch {
      // Not counted; the answer itself was already made.
    }
  },

  async read(now = new Date()) {
    const { day } = periods(now);
    const sql = db();
    const [counts] = await sql<{ answers: number; reused: number }[]>`
      select coalesce(sum(answers), 0)::int as answers, coalesce(sum(reused), 0)::int as reused
      from answer_stats where day = ${day}`;
    const [usage] = await sql<{ calls: number }[]>`
      select coalesce(sum(calls), 0)::int as calls from gemini_usage where period = ${day}`;
    return summarize(day, counts, usage.calls);
  },
};
