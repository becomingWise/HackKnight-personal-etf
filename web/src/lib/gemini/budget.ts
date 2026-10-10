// Per-model call budgets and blocks. The counters live in Tiger so every server instance sees
// the same numbers; if the database is unreachable, a per-instance in-memory copy takes over.
import { db } from "../db/client";
import { MODELS, MODEL_IDS, budgetOf, periods, type ModelId } from "./models";

export type Refusal = "blocked" | "minute" | "day";

export type ModelUsage = {
  model: ModelId;
  usedToday: number;
  /** 80% of the model's daily limit: what the app lets itself use. */
  dailyBudget: number;
  remainingToday: number;
  limitPerDay: number;
  blockedUntil: string | null;
  blockedBecause: string | null;
};

export type ModelBudget = {
  /** Counts one call against the model's minute and day budgets. Returns why not, or null when the call may go ahead. */
  reserve(model: ModelId, now: Date): Promise<Refusal | null>;
  /** Keeps the model out of every chain until the given time. */
  block(model: ModelId, until: Date, reason: string): Promise<void>;
  usage(now: Date): Promise<ModelUsage[]>;
};

function usageRow(
  model: ModelId,
  used: number,
  block: { until: Date; reason: string } | undefined,
  now: Date,
): ModelUsage {
  const { perDay } = budgetOf(model);
  const active = block && block.until > now ? block : undefined;
  return {
    model,
    usedToday: used,
    dailyBudget: perDay,
    remainingToday: Math.max(0, perDay - used),
    limitPerDay: MODELS[model].rpd,
    blockedUntil: active?.until.toISOString() ?? null,
    blockedBecause: active?.reason ?? null,
  };
}

/** In-memory budget: the fallback when Tiger is unreachable, and what tests use. */
export function memoryModelBudget(): ModelBudget {
  const calls = new Map<string, number>();
  const blocks = new Map<ModelId, { until: Date; reason: string }>();
  return {
    async reserve(model, now) {
      const block = blocks.get(model);
      if (block && block.until > now) return "blocked";
      const { minute, day } = periods(now);
      const budget = budgetOf(model);
      const bump = (period: string) => {
        const next = (calls.get(`${model}|${period}`) ?? 0) + 1;
        calls.set(`${model}|${period}`, next);
        return next;
      };
      // The minute first: a call turned away for the minute must not use up the day.
      if (bump(minute) > budget.perMinute) return "minute";
      if (bump(day) > budget.perDay) return "day";
      return null;
    },
    async block(model, until, reason) {
      blocks.set(model, { until, reason });
    },
    async usage(now) {
      const { day } = periods(now);
      return MODEL_IDS.map((model) =>
        usageRow(model, calls.get(`${model}|${day}`) ?? 0, blocks.get(model), now),
      );
    },
  };
}

async function bump(model: ModelId, period: string): Promise<number> {
  const rows = await db()<{ calls: number }[]>`
    insert into gemini_usage (model, period, calls) values (${model}, ${period}, 1)
    on conflict (model, period) do update set calls = gemini_usage.calls + 1, updated_at = now()
    returning calls`;
  return rows[0].calls;
}

export function tigerModelBudget(): ModelBudget {
  const memory = memoryModelBudget();
  return {
    async reserve(model, now) {
      try {
        const blocked = await db()<{ model: string }[]>`
          select model from gemini_blocks where model = ${model} and blocked_until > ${now}`;
        if (blocked.length) return "blocked";
        const { minute, day } = periods(now);
        const budget = budgetOf(model);
        if ((await bump(model, minute)) > budget.perMinute) return "minute";
        if ((await bump(model, day)) > budget.perDay) return "day";
        // Occasional cleanup of old minutes; day rows are kept as a record.
        if (Math.random() < 0.02) {
          void db()`delete from gemini_usage where period like 'm:%' and updated_at < now() - interval '1 day'`.catch(
            () => {},
          );
        }
        return null;
      } catch {
        return memory.reserve(model, now);
      }
    },

    async block(model, until, reason) {
      await memory.block(model, until, reason);
      try {
        await db()`
          insert into gemini_blocks (model, blocked_until, reason) values (${model}, ${until}, ${reason})
          on conflict (model) do update set
            blocked_until = greatest(gemini_blocks.blocked_until, excluded.blocked_until),
            reason = excluded.reason`;
      } catch {
        // The in-memory block still holds for this instance.
      }
    },

    async usage(now) {
      try {
        const { day } = periods(now);
        const used = await db()<{ model: string; calls: number }[]>`
          select model, calls from gemini_usage where period = ${day}`;
        const blocks = await db()<{ model: string; blocked_until: Date; reason: string }[]>`
          select model, blocked_until, reason from gemini_blocks`;
        return MODEL_IDS.map((model) => {
          const block = blocks.find((b) => b.model === model);
          return usageRow(
            model,
            used.find((u) => u.model === model)?.calls ?? 0,
            block && { until: block.blocked_until, reason: block.reason },
            now,
          );
        });
      } catch {
        return memory.usage(now);
      }
    },
  };
}
