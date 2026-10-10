// Gemini calls for the track-record replay: every answer is stored in Tiger (replay_calls) under a
// hash of its request, so a second run costs nothing. New calls are counted, capped and paced to
// stay under the per-minute budget of the Flash-Lite models.
import { createHash } from "node:crypto";
import { db } from "../db/client";
import type { GenerateJson, GenerateJsonArgs } from "../sponsors/gemini";

export type StoredCall = { model: string; response: unknown };
export type CallStore = {
  get(key: string): Promise<StoredCall | null>;
  set(key: string, label: string, call: StoredCall): Promise<void>;
};

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
};

export function memoryCallStore(): CallStore {
  const rows = new Map<string, StoredCall>();
  return {
    get: async (key) => rows.get(key) ?? null,
    set: async (key, _label, call) => void rows.set(key, structuredClone(call)),
  };
}

export const callKey = (args: Pick<GenerateJsonArgs, "task" | "system" | "prompt" | "schema">) =>
  createHash("sha256")
    .update(JSON.stringify([args.task ?? "decide", args.system, args.prompt, args.schema]))
    .digest("hex");

/** The replay may not make this many new Gemini calls without Lucas's OK. */
export class CallLimitError extends Error {
  constructor(readonly limit: number) {
    super(`The replay reached its limit of ${limit} new Gemini calls.`);
  }
}

export type CachedCalls = {
  /** The stored answer when there is one; otherwise one paced Gemini call, stored afterwards. */
  ask(label: string, args: GenerateJsonArgs): Promise<StoredCall & { cached: boolean }>;
  /** New Gemini calls made through this object. */
  made(): number;
};

export function createCachedCalls(deps: {
  generate: GenerateJson;
  store: CallStore;
  /** New calls allowed in this run. */
  limit: number;
  /** Pause before every new call after the first, so a run stays under the per-minute budget. */
  paceMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): CachedCalls {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  let made = 0;
  return {
    async ask(label, args) {
      const key = callKey(args);
      const stored = await deps.store.get(key);
      if (stored) return { ...stored, cached: true };
      if (made >= deps.limit) throw new CallLimitError(deps.limit);
      if (made > 0 && deps.paceMs) await sleep(deps.paceMs);
      made += 1;
      let model = "unknown";
      const response = await deps.generate({ ...args, onModel: (used) => (model = used) });
      await deps.store.set(key, label, { model, response });
      return { model, response, cached: false };
    },
    made: () => made,
  };
}
