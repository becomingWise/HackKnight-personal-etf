// Live proof of the Tiger Data (TimescaleDB) usage for GET /api/built-with.
import { db } from "../db/client";
import { tigerOddsRepo } from "../odds/repo";

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, ms: Math.round((performance.now() - started) * 10) / 10 };
}

export async function tigerProof() {
  const sql = db();

  const versions = await sql<{ postgres: string; timescaledb: string | null }[]>`
    select current_setting('server_version') as postgres,
           (select extversion from pg_extension where extname = 'timescaledb') as timescaledb`;

  const counts = await timed(
    () => sql<
      {
        odds_ticks: number;
        markets: number;
        baskets: number;
        hourly_buckets: number;
        last_tick_at: Date | null;
        first_tick_at: Date | null;
        tracked_markets: number;
      }[]
    >`
      select
        (select count(*)::int from odds_ticks) as odds_ticks,
        (select count(*)::int from markets) as markets,
        (select count(*)::int from baskets) as baskets,
        (select count(*)::int from odds_1h) as hourly_buckets,
        (select max(time) from odds_ticks where source = 'tick') as last_tick_at,
        (select min(time) from odds_ticks) as first_tick_at,
        (select count(distinct m)::int from baskets, unnest(market_ids) m) as tracked_markets`,
  );

  const bySource = await sql<{ source: string; ticks: number }[]>`
    select source, count(*)::int as ticks from odds_ticks group by 1 order by 2 desc`;

  const chunks = await sql<{ chunks: number; columnstore_chunks: number; size: string }[]>`
    select
      count(*)::int as chunks,
      count(*) filter (where is_compressed)::int as columnstore_chunks,
      pg_size_pretty(hypertable_size('odds_ticks')) as size
    from timescaledb_information.chunks where hypertable_name = 'odds_ticks'`;

  const jobs = await sql<
    { job: string; every: string; last_status: string | null; last_success: Date | null }[]
  >`
    select j.proc_name as job, j.schedule_interval::text as every,
           s.last_run_status as last_status, s.last_successful_finish as last_success
    from timescaledb_information.jobs j
    left join timescaledb_information.job_stats s using (job_id)
    where j.hypertable_name = 'odds_ticks'
       or j.proc_name = 'policy_refresh_continuous_aggregate'
    order by 1`;

  // The showcase queries, timed live: the same ones the chart endpoints run.
  const busiest = await sql<{ id: string }[]>`
    select market_id as id from odds_ticks
    where time > now() - interval '30 days'
    group by 1 order by count(*) desc limit 6`;
  const ids = busiest.map((r) => r.id);
  const now = new Date();
  const day = ids.length ? (await tigerOddsRepo.series(ids.slice(0, 1), "1d", now)).ms : null;
  const week = ids.length ? (await tigerOddsRepo.series(ids.slice(0, 1), "7d", now)).ms : null;
  const month = ids.length ? await tigerOddsRepo.series(ids, "30d", now) : null;

  const c = counts.value[0];
  return {
    service: "Tiger Cloud (PostgreSQL + TimescaleDB)",
    postgres: versions[0].postgres,
    timescaledb: versions[0].timescaledb,
    rows: {
      odds_ticks: c.odds_ticks,
      markets: c.markets,
      baskets: c.baskets,
      odds_1h_buckets: c.hourly_buckets,
    },
    ticksBySource: Object.fromEntries(bySource.map((r) => [r.source, r.ticks])),
    trackedMarkets: c.tracked_markets,
    firstTickAt: c.first_tick_at?.toISOString() ?? null,
    lastTickAt: c.last_tick_at?.toISOString() ?? null,
    hypertable: {
      name: "odds_ticks",
      chunks: chunks[0]?.chunks ?? 0,
      columnstoreChunks: chunks[0]?.columnstore_chunks ?? 0,
      size: chunks[0]?.size ?? null,
    },
    continuousAggregate: { name: "odds_1h", bucket: "1 hour", realTime: true },
    jobs: jobs.map((j) => ({
      job: j.job,
      every: j.every,
      lastStatus: j.last_status,
      lastSuccess: j.last_success?.toISOString() ?? null,
    })),
    queryLatencyMs: {
      rowCounts: counts.ms,
      marketHistory1d_gapfill_over_ticks: day,
      marketHistory7d_gapfill_over_hourly_aggregate: week,
      basketOdds30d_gapfill_over_hourly_aggregate: month?.ms ?? null,
      basketOdds30d_markets: ids.length,
      basketOdds30d_points: month?.points.length ?? 0,
    },
  };
}
