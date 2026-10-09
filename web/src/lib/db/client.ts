import postgres from "postgres";
import { env } from "../env";

type Sql = ReturnType<typeof postgres>;

// One client per server instance. Tiger's free plan has no pooler and Vercel runs many
// instances, so each one keeps at most 3 connections and drops them when idle.
const globalForDb = globalThis as unknown as { __prophetfSql?: Sql };

export function db(): Sql {
  if (!globalForDb.__prophetfSql) {
    const url = env().DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.__prophetfSql = postgres(url, {
      max: 3,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => {},
    });
  }
  return globalForDb.__prophetfSql;
}

/** Runs a query function and reports how long it took, for /api/health and /built-with. */
export async function timed<T>(fn: (sql: Sql) => Promise<T>): Promise<{ result: T; ms: number }> {
  const sql = db();
  const start = performance.now();
  const result = await fn(sql);
  return { result, ms: Math.round((performance.now() - start) * 10) / 10 };
}
