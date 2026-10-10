// Tiger (TimescaleDB) queries for odds history. Everything SQL lives here.
import { db } from "../db/client";

export type MarketRow = {
  id: string;
  question: string;
  url: string | null;
  yesTokenId: string | null;
  endDate: string | null;
  closed: boolean;
  backfilledAt: string | null;
  lastTickAt: string | null;
};

export type MarketUpsert = {
  id: string;
  question: string;
  url?: string | null;
  yesTokenId?: string | null;
  endDate?: string | null;
  closed?: boolean;
};

export type Tick = { time: Date; marketId: string; probability: number; source: string };

export type Range = "1d" | "7d" | "30d";

/** How each range is read: raw ticks for a day, the hourly continuous aggregate beyond that. */
export const RANGES: Record<
  Range,
  { spanSeconds: number; bucketSeconds: number; from: "odds_ticks" | "odds_1h" }
> = {
  "1d": { spanSeconds: 86_400, bucketSeconds: 600, from: "odds_ticks" },
  "7d": { spanSeconds: 7 * 86_400, bucketSeconds: 3600, from: "odds_1h" },
  "30d": { spanSeconds: 30 * 86_400, bucketSeconds: 3 * 3600, from: "odds_1h" },
};

export type SeriesPoint = { marketId: string; t: Date; p: number };

export type OddsRepo = {
  upsertMarkets(markets: MarketUpsert[]): Promise<void>;
  insertTicks(ticks: Tick[]): Promise<number>;
  markets(ids: string[]): Promise<MarketRow[]>;
  /** Ids of every market cited by a saved basket. */
  citedMarketIds(): Promise<string[]>;
  markBackfilled(id: string): Promise<void>;
  markTicked(ids: string[], at: Date): Promise<void>;
  refreshHourly(from: Date, to: Date): Promise<void>;
  series(ids: string[], range: Range, now: Date): Promise<{ points: SeriesPoint[]; ms: number }>;
};

export type PastOdds = Map<string, { d1: number | null; d7: number | null }>;

/**
 * What each market's Yes odds were about 24 hours and 7 days ago, from the ticks we stored.
 * null when there is no tick near that time (within 12 hours before it, or 24 for the week).
 */
export async function tigerPastOdds(ids: string[], now: Date): Promise<PastOdds> {
  if (!ids.length) return new Map();
  const at = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const rows = await db()<{ id: string; d1: number | null; d7: number | null }[]>`
    select m.id,
      (select probability from odds_ticks t
        where t.market_id = m.id and t.outcome = 'Yes' and t.time <= ${at(24)} and t.time > ${at(36)}
        order by t.time desc limit 1) as d1,
      (select probability from odds_ticks t
        where t.market_id = m.id and t.outcome = 'Yes' and t.time <= ${at(168)} and t.time > ${at(192)}
        order by t.time desc limit 1) as d7
    from unnest(${ids}::text[]) as m(id)`;
  return new Map(rows.map((r) => [r.id, { d1: r.d1, d7: r.d7 }]));
}

function toIso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

export const tigerOddsRepo: OddsRepo = {
  async upsertMarkets(markets) {
    if (!markets.length) return;
    const sql = db();
    const rows = [...new Map(markets.map((m) => [m.id, m])).values()].map((m) => ({
      id: m.id,
      question: m.question,
      url: m.url ?? null,
      yes_token_id: m.yesTokenId ?? null,
      end_date: m.endDate ? new Date(m.endDate) : null,
      closed: m.closed ?? false,
    }));
    await sql`
      insert into markets ${sql(rows, "id", "question", "url", "yes_token_id", "end_date", "closed")}
      on conflict (id) do update set
        question = excluded.question,
        url = coalesce(excluded.url, markets.url),
        yes_token_id = coalesce(excluded.yes_token_id, markets.yes_token_id),
        end_date = coalesce(excluded.end_date, markets.end_date),
        closed = markets.closed or excluded.closed`;
  },

  async insertTicks(ticks) {
    if (!ticks.length) return 0;
    const sql = db();
    let inserted = 0;
    for (let i = 0; i < ticks.length; i += 1000) {
      const rows = ticks.slice(i, i + 1000).map((t) => ({
        time: t.time,
        market_id: t.marketId,
        probability: t.probability,
        source: t.source,
      }));
      const result = await sql`
        insert into odds_ticks ${sql(rows, "time", "market_id", "probability", "source")}
        on conflict (market_id, outcome, time) do nothing`;
      inserted += result.count;
    }
    return inserted;
  },

  async markets(ids) {
    if (!ids.length) return [];
    const rows = await db()<
      {
        id: string;
        question: string;
        url: string | null;
        yes_token_id: string | null;
        end_date: Date | null;
        closed: boolean;
        backfilled_at: Date | null;
        last_tick_at: Date | null;
      }[]
    >`select id, question, url, yes_token_id, end_date, closed, backfilled_at, last_tick_at
      from markets where id = any(${ids})`;
    return rows.map((r) => ({
      id: r.id,
      question: r.question,
      url: r.url,
      yesTokenId: r.yes_token_id,
      endDate: toIso(r.end_date),
      closed: r.closed,
      backfilledAt: toIso(r.backfilled_at),
      lastTickAt: toIso(r.last_tick_at),
    }));
  },

  async citedMarketIds() {
    const rows = await db()<{ id: string }[]>`
      select distinct unnest(market_ids) as id from baskets`;
    return rows.map((r) => r.id);
  },

  async markBackfilled(id) {
    await db()`update markets set backfilled_at = now() where id = ${id}`;
  },

  async markTicked(ids, at) {
    if (!ids.length) return;
    await db()`update markets set last_tick_at = ${at} where id = any(${ids})`;
  },

  async refreshHourly(from, to) {
    await db()`call refresh_continuous_aggregate('odds_1h', ${from}::timestamptz, ${to}::timestamptz)`;
  },

  // One query for any number of markets: time_bucket_gapfill gives every market the same time
  // axis and locf carries the last known odds across buckets without a tick.
  async series(ids, range, now) {
    if (!ids.length) return { points: [], ms: 0 };
    const sql = db();
    const cfg = RANGES[range];
    const start = new Date(now.getTime() - cfg.spanSeconds * 1000);
    const bucket = `${cfg.bucketSeconds} seconds`;
    const started = performance.now();
    const rows =
      cfg.from === "odds_ticks"
        ? await sql<{ market_id: string; t: Date; p: number | null }[]>`
            select
              market_id,
              time_bucket_gapfill(${bucket}::interval, time, ${start}::timestamptz, ${now}::timestamptz) as t,
              locf(last(probability, time)) as p
            from odds_ticks
            where market_id = any(${ids}) and outcome = 'Yes'
              and time >= ${start} and time <= ${now}
            group by 1, 2
            order by 1, 2`
        : await sql<{ market_id: string; t: Date; p: number | null }[]>`
            select
              market_id,
              time_bucket_gapfill(${bucket}::interval, bucket, ${start}::timestamptz, ${now}::timestamptz) as t,
              locf(last(close, bucket)) as p
            from odds_1h
            where market_id = any(${ids}) and outcome = 'Yes'
              and bucket >= ${start} and bucket <= ${now}
            group by 1, 2
            order by 1, 2`;
    const ms = Math.round((performance.now() - started) * 10) / 10;
    return {
      // Buckets before a market's first tick have nothing to carry forward.
      points: rows.flatMap((r) =>
        r.p === null ? [] : [{ marketId: r.market_id, t: r.t, p: r.p }],
      ),
      ms,
    };
  },
};
