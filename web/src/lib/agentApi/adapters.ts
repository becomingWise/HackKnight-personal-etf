// What the stock agent (src/lib/agent-core, a copy of /agent) needs from this backend: session
// memory in a Tiger table, the shared response cache, and the per-model Gemini budgets.
import { tigerApiCache, type ApiCache } from "../cache/apiCache";
import { db } from "../db/client";
import { type ModelBudget } from "../gemini/budget";
import { MODELS, type ModelId } from "../gemini/models";
import { createMemoryStore, withBasket, withPreference } from "../agent-core/agent/memory.js";

export type MemoryRecord = { preferences: string[]; baskets: unknown[] };
export type AgentMemory = {
  load(sessionId: string): Promise<MemoryRecord>;
  rememberPreference(sessionId: string, preference: string): Promise<void>;
  rememberBasket(sessionId: string, basket: unknown): Promise<void>;
};

/** Session memory in Tiger. A database problem falls back to this instance's own memory. */
export function tigerAgentMemory(): AgentMemory {
  const local = createMemoryStore() as AgentMemory;
  const load = async (sessionId: string): Promise<MemoryRecord> => {
    const rows = await db()<{ preferences: string[]; baskets: unknown[] }[]>`
      select preferences, baskets from agent_memory where session_id = ${sessionId}`;
    return rows[0] ?? { preferences: [], baskets: [] };
  };
  const save = async (sessionId: string, record: MemoryRecord) => {
    const sql = db();
    await sql`
      insert into agent_memory (session_id, preferences, baskets, updated_at)
      values (${sessionId}, ${sql.json(record.preferences)}, ${sql.json(record.baskets as never)}, now())
      on conflict (session_id) do update set
        preferences = excluded.preferences, baskets = excluded.baskets, updated_at = now()`;
    // Occasional cleanup of sessions nobody has used for a week.
    if (Math.random() < 0.02) {
      void sql`delete from agent_memory where updated_at < now() - interval '7 days'`.catch(
        () => {},
      );
    }
  };
  return {
    async load(sessionId) {
      try {
        return await load(sessionId);
      } catch {
        return local.load(sessionId);
      }
    },
    async rememberPreference(sessionId, preference) {
      try {
        await save(sessionId, withPreference(await load(sessionId), preference) as MemoryRecord);
      } catch {
        await local.rememberPreference(sessionId, preference);
      }
    },
    async rememberBasket(sessionId, basket) {
      try {
        await save(sessionId, withBasket(await load(sessionId), basket) as MemoryRecord);
      } catch {
        await local.rememberBasket(sessionId, basket);
      }
    },
  };
}

/** The agent's cache on top of the shared response cache (kind "agent"). */
export function agentCache(cache: ApiCache = tigerApiCache) {
  return {
    async get(key: string) {
      return (await cache.get("agent", key))?.value ?? null;
    },
    async set(key: string, value: unknown, ttlMs: number) {
      await cache.set("agent", key, value, Math.round(ttlMs / 1000));
    },
  };
}

const known = (model: string): model is ModelId => model in MODELS;
// A search block is stored beside the model blocks under its own name, so a model that has no
// Google Search quota stays usable for the agent's own turns.
const blockKey = (model: string, purpose: string) =>
  (purpose === "search" ? `search:${model}` : model) as ModelId;

async function searchBlocked(model: string, now: Date): Promise<boolean> {
  try {
    const rows = await db()<{ model: string }[]>`
      select model from gemini_blocks where model = ${`search:${model}`} and blocked_until > ${now}`;
    return rows.length > 0;
  } catch {
    return false;
  }
}

/** The agent's budget hooks on top of the per-model budgets every Gemini call here goes through. */
export function agentBudget(budget: ModelBudget, now: () => Date = () => new Date()) {
  return {
    async reserve(model: string, purpose: string): Promise<string | null> {
      if (!known(model)) return "unknown model";
      if (purpose === "search" && (await searchBlocked(model, now()))) return "blocked";
      const refusal = await budget.reserve(model, now());
      return refusal === null
        ? null
        : refusal === "blocked"
          ? "blocked"
          : `${refusal} budget used up`;
    },
    async block(model: string, purpose: string, until: number, reason: string): Promise<void> {
      await budget.block(blockKey(model, purpose), new Date(until), reason);
    },
    async available(models: string[], purpose: string): Promise<boolean> {
      if (purpose !== "search") return true;
      const blocked = await Promise.all(models.map((model) => searchBlocked(model, now())));
      return blocked.some((b) => !b);
    },
  };
}
