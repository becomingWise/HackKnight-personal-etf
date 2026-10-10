// Gemini calls for the track-record replay: every answer is stored in Tiger (replay_calls), so a
// second run costs nothing. Every request really sent to a model is counted against one total
// that is kept in the database, capped, and paced to stay under the per-minute budget of the
// Flash-Lite models.
import { createHash } from "node:crypto";
import { db } from "../db/client";
import type { GenerateJson, GenerateJsonArgs } from "../sponsors/gemini";

export type StoredCall = { model: string; response: unknown };
export type CallStore = {
  get(key: string): Promise<StoredCall | null>;
  set(key: string, label: string, call: StoredCall): Promise<void>;
  /** Gemini requests the replay has sent so far, over all runs. */
  spent(): Promise<number>;
  addSpent(calls: number): Promise<void>;
};

const BUDGET_KEY = "budget";
/** The leak check (2 calls) ran before the counter existed. */
const SPENT_BEFORE_COUNTER = 2;

export const tigerCallStore: CallStore = {
  async get(key) {
    const rows = await db()<{ model: string; response: unknown }[]>`
      select model, response from replay_calls where key = ${key}`;
    return rows[0] ?? null;
  },
  async set(key, label, call) {
    const sql = db();
    await sql`
      insert into replay_calls (key, label, model, response)
      values (${key}, ${label}, ${call.model}, ${sql.json(call.response as never)})
      on conflict (key) do nothing`;
  },
  async spent() {
    const rows = await db()<{ spent: number }[]>`
      select (response->>'spent')::int as spent from replay_calls where key = ${BUDGET_KEY}`;
    return rows[0]?.spent ?? SPENT_BEFORE_COUNTER;
  },
  async addSpent(calls) {
    const sql = db();
    await sql`
      insert into replay_calls (key, label, model, response)
      values (${BUDGET_KEY}, 'Gemini requests sent by the replay', 'none',
              ${sql.json({ spent: SPENT_BEFORE_COUNTER + calls })})
      on conflict (key) do update set
        response = jsonb_build_object('spent', (replay_calls.response->>'spent')::int + ${calls})`;
  },
};

export function memoryCallStore(spentBefore = 0): CallStore {
  const rows = new Map<string, StoredCall>();
  let spent = spentBefore;
  return {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, _label, call) => void rows.set(key, structuredClone(call)),
    spent: async () => spent,
    addSpent: async (calls) => void (spent += calls),
  };
}

export const callKey = (args: Pick<GenerateJsonArgs, "task" | "system" | "prompt" | "schema">) =>
  createHash("sha256")
    .update(JSON.stringify([args.task ?? "decide", args.system, args.prompt, args.schema]))
    .digest("hex");

/** A fixed key for a call whose prompt may change in details (prices that get re-adjusted). */
export const namedKey = (...parts: string[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

/** The replay may not send more Gemini requests than this without Lucas's OK. */
export class CallLimitError extends Error {
  constructor(readonly limit: number) {
    super(`The replay reached its limit of ${limit} Gemini calls.`);
  }
}

export type CachedCalls = {
  /** The stored answer when there is one; otherwise one paced Gemini call, stored afterwards. */
  ask(
    label: string,
    args: GenerateJsonArgs,
    key?: string,
  ): Promise<StoredCall & { cached: boolean }>;
  /** Counts requests made elsewhere (the stock agent's picks) against the same limit. */
  spend(calls: number): Promise<void>;
  /** Gemini requests sent through this object. */
  made(): number;
  /** How many more may be sent in this run. */
  remaining(): number;
};

export function createCachedCalls(deps: {
  generate: GenerateJson;
  store: CallStore;
  /** Requests allowed in this run. */
  limit: number;
  /** Pause before every new call after the first, so a run stays under the per-minute budget. */
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): CachedCalls {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let made = 0;
  let asked = 0;
  return {
    async ask(label, args, key = callKey(args)) {
      const stored = await deps.store.get(key);
      if (stored) return { ...stored, cached: true };
      if (made >= deps.limit) throw new CallLimitError(deps.limit);
      if (asked > 0 && deps.paceMs) await sleep(deps.paceMs);
      asked += 1;
      let model = "unknown";
      let attempts = 0;
      try {
        const response = await deps.generate({
          ...args,
          onModel: (used) => (model = used),
          // A call may try a second model after a failure: each request counts.
          onAttempt: () => {
            if (made >= deps.limit) throw new CallLimitError(deps.limit);
            attempts += 1;
            made += 1;
          },
        });
        await deps.store.set(key, label, { model, response });
        return { model, response, cached: false };
      } finally {
        // A generate that does not report its requests (a test double) counts as one.
        if (attempts === 0) {
          attempts = 1;
          made += 1;
        }
        await deps.store.addSpent(attempts).catch(() => {});
      }
    },
    async spend(calls) {
      made += calls;
      await deps.store.addSpent(calls).catch(() => {});
    },
    made: () => made,
    remaining: () => Math.max(0, deps.limit - made),
  };
}
