// The one LLM step of the MOCK analyst: the idea becomes Polymarket search queries and the
// sectors it touches, so ideas without a sector keyword find markets too. One call on the
// lighter model, cached for a day, 5 seconds at most; on any failure the caller falls back to
// keyword matching.
import { z } from "zod";
import { planCacheKey, type ApiCache } from "../cache/apiCache";
import { ThinkingLevel, type GenerateJson } from "../sponsors/gemini";
import { SECTORS, SECTOR_IDS } from "../stocks/universe";

export type SearchPlan = { queries: string[]; sectors: string[] };
/** Resolves to null when no plan could be made. Never throws. */
export type Planner = (idea: string, signal?: AbortSignal) => Promise<SearchPlan | null>;

export const PLAN_TIMEOUT_MS = 5000;
const PLAN_TTL_SECONDS = 24 * 3600;

const planSchema = z.object({
  queries: z.array(z.string().trim().min(2).max(80)).min(1).max(6),
  sectors: z.array(z.enum(SECTOR_IDS as [string, ...string[]])).max(4),
});

const PLAN_JSON_SCHEMA = {
  type: "object",
  properties: {
    queries: { type: "array", items: { type: "string" }, minItems: 3, maxItems: 6 },
    sectors: { type: "array", items: { type: "string", enum: SECTOR_IDS }, maxItems: 4 },
  },
  required: ["queries", "sectors"],
};

const PLAN_SYSTEM = `You turn an investing idea into Polymarket search queries.
Return 3 to 6 short English search queries (2 to 4 words each) for prediction markets about real-world events that would move stocks related to the idea: policy, geopolitics, macro, technology milestones, company events. Polymarket's search matches words, so use the plain names of people, companies, countries, laws and events.
Also return the ids of the listed sectors whose companies the idea would clearly affect, most affected first. Return no sector when the idea has nothing to do with any listed sector; do not stretch.
The idea may be in any language; queries are always in English.`;

export function createPlanner(deps: { generate: GenerateJson; cache?: ApiCache }): Planner {
  return async function plan(idea, signal) {
    const key = planCacheKey(idea);
    const hit = await deps.cache?.get<SearchPlan>("plan", key);
    if (hit) return hit.value;
    try {
      const raw = await deps.generate({
        system: PLAN_SYSTEM,
        prompt: `Sectors: ${SECTORS.map((s) => `${s.id} (${s.name}: ${s.holdings.map((h) => h.symbol).join(", ")})`).join("; ")}\n\nIdea: ${idea}`,
        schema: PLAN_JSON_SCHEMA,
        timeoutMs: PLAN_TIMEOUT_MS,
        thinking: ThinkingLevel.MINIMAL,
        prefer: "lite",
        fallback: false,
        signal,
      });
      const parsed = planSchema.safeParse(raw);
      if (!parsed.success) return null;
      const plan: SearchPlan = {
        queries: [...new Set(parsed.data.queries)],
        sectors: [...new Set(parsed.data.sectors)],
      };
      await deps.cache?.set("plan", key, plan, PLAN_TTL_SECONDS);
      return plan;
    } catch {
      return null;
    }
  };
}
