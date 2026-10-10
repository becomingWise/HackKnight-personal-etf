import { timed } from "./db/client";
import { env } from "./env";
import { sponsorStatus } from "./flags";
import { analystMode } from "./pipeline/run";

type DbInfo = { postgres: string; timescaledb: string | null; migrations: number };
export type DbHealth = ({ ok: true; latency_ms: number } & DbInfo) | { ok: false; error: string };

export async function checkDb(): Promise<DbHealth> {
  try {
    const { result, ms } = await timed(
      (sql) => sql<DbInfo[]>`
        select
          current_setting('server_version') as postgres,
          (select extversion from pg_extension where extname = 'timescaledb') as timescaledb,
          (select count(*)::int from schema_migrations) as migrations`,
    );
    return { ok: true, latency_ms: ms, ...result[0] };
  } catch (err) {
    // Error code only: driver messages can include the database host.
    const code = (err as { code?: string } | null)?.code;
    return { ok: false, error: code ?? "database unreachable" };
  }
}

export async function getHealth() {
  const database = await checkDb();
  return {
    ok: database.ok,
    time: new Date().toISOString(),
    database,
    sponsors: sponsorStatus(),
    // Which analyst writes the evidence packet, and whether the checker's LLM review is on.
    pipeline: { analystMode: analystMode(), checkerLlm: env().CHECKER_LLM },
  };
}
