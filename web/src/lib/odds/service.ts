// Odds tracking: record what we observe, backfill history once per market, tick every minute,
// and read series back for charts.
import {
  fetchMarketsByIds,
  fetchPriceHistory,
  type FetchHistory,
  type FetchMarkets,
} from "../polymarket/markets";
import {
  RANGES,
  tigerOddsRepo,
  type MarketRow,
  type MarketUpsert,
  type OddsRepo,
  type Range,
  type Tick,
} from "./repo";

export type OddsDeps = {
  repo: OddsRepo;
  fetchMarkets: FetchMarkets;
  fetchHistory: FetchHistory;
  now: () => Date;
};

export const defaultOddsDeps: OddsDeps = {
  repo: tigerOddsRepo,
  fetchMarkets: fetchMarketsByIds,
  fetchHistory: fetchPriceHistory,
  now: () => new Date(),
};

export type Observation = MarketUpsert & { probability: number; observedAt?: Date };

/** Markets are tracked by Polymarket's numeric id; anything else is ignored. */
const isMarketId = (id: string) => /^\d{1,20}$/.test(id);

/** Records odds seen while answering a request. Callers treat failures as non-fatal. */
export async function recordObservations(
  observations: Observation[],
  source: string,
  deps: OddsDeps = defaultOddsDeps,
): Promise<number> {
  const valid = observations.filter(
    (o) => isMarketId(o.id) && o.probability >= 0 && o.probability <= 1,
  );
  if (!valid.length) return 0;
  const now = deps.now();
  await deps.repo.upsertMarkets(valid);
  return deps.repo.insertTicks(
    valid.map((o) => ({
      time: o.observedAt ?? now,
      marketId: o.id,
      probability: o.probability,
      source,
    })),
  );
}

/**
 * Loads 30 days of hourly history plus the last day at 10-minute resolution for one market,
 * once. Returns the number of ticks stored.
 */
export async function backfillMarket(
  market: MarketRow,
  deps: OddsDeps = defaultOddsDeps,
): Promise<number> {
  let tokenId = market.yesTokenId;
  if (!tokenId) {
    const [fresh] = await deps.fetchMarkets([market.id]);
    if (fresh) {
      await deps.repo.upsertMarkets([fresh]);
      tokenId = fresh.yesTokenId;
    }
  }
  let inserted = 0;
  if (tokenId) {
    const [month, day] = await Promise.all([
      deps.fetchHistory(tokenId, "1m", 3600),
      deps.fetchHistory(tokenId, "1d", 600),
    ]);
    const ticks: Tick[] = [...month, ...day].map((p) => ({
      time: p.time,
      marketId: market.id,
      probability: p.probability,
      source: "backfill",
    }));
    inserted = await deps.repo.insertTicks(ticks);
    if (ticks.length) {
      const first = Math.min(...ticks.map((t) => t.time.getTime()));
      // Materialize the hourly aggregate for the loaded window now; the policy would also
      // get to it within 15 minutes, so a failure here only delays the 7d/30d charts.
      await deps.repo.refreshHourly(new Date(first - 3_600_000), deps.now()).catch(() => {});
    }
  }
  await deps.repo.markBackfilled(market.id);
  return inserted;
}

/**
 * Makes sure the given markets exist in Tiger and have history. Unknown ids are looked up
 * on Polymarket. Returns the rows that exist afterwards.
 */
export async function ensureTracked(
  ids: string[],
  deps: OddsDeps = defaultOddsDeps,
  maxBackfills = 8,
): Promise<MarketRow[]> {
  const wanted = [...new Set(ids)].filter(isMarketId);
  if (!wanted.length) return [];
  let rows = await deps.repo.markets(wanted);
  const missing = wanted.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) {
    const fetched = await deps.fetchMarkets(missing).catch(() => []);
    if (fetched.length) {
      await deps.repo.upsertMarkets(fetched);
      await deps.repo.insertTicks(
        fetched.flatMap((m) =>
          m.probability === null
            ? []
            : [{ time: deps.now(), marketId: m.id, probability: m.probability, source: "tick" }],
        ),
      );
      rows = await deps.repo.markets(wanted);
    }
  }
  const pending = rows.filter((r) => !r.backfilledAt).slice(0, maxBackfills);
  if (pending.length) {
    await Promise.all(pending.map((m) => backfillMarket(m, deps).catch(() => 0)));
    rows = await deps.repo.markets(wanted);
  }
  return rows;
}

export type TickResult = {
  markets: number;
  ticks: number;
  closed: number;
  backfilled: number;
  ms: number;
};

/**
 * The every-minute job: one tick per open market cited by a saved basket, stamped on the
 * minute so a repeated run in the same minute changes nothing.
 */
export async function runTick(deps: OddsDeps = defaultOddsDeps): Promise<TickResult> {
  const started = Date.now();
  const now = deps.now();
  const minute = new Date(Math.floor(now.getTime() / 60_000) * 60_000);

  const cited = (await deps.repo.citedMarketIds()).filter(isMarketId);
  const known = await deps.repo.markets(cited);
  const closedIds = new Set(known.filter((m) => m.closed).map((m) => m.id));
  const open = cited.filter((id) => !closedIds.has(id));

  const snapshots = open.length ? await deps.fetchMarkets(open) : [];
  await deps.repo.upsertMarkets(snapshots);
  const ticks = snapshots.flatMap((m) =>
    m.probability === null
      ? []
      : [{ time: minute, marketId: m.id, probability: m.probability, source: "tick" }],
  );
  const inserted = await deps.repo.insertTicks(ticks);
  await deps.repo.markTicked(
    ticks.map((t) => t.marketId),
    minute,
  );

  // A few backfills per run keep the job well under its time limit.
  const rows = await deps.repo.markets(open);
  const pending = rows.filter((r) => !r.backfilledAt).slice(0, 4);
  let backfilled = 0;
  for (const market of pending) {
    if (Date.now() - started > 20_000) break;
    await backfillMarket(market, deps).then(
      () => backfilled++,
      () => {},
    );
  }

  return {
    markets: open.length,
    ticks: inserted,
    closed: snapshots.filter((m) => m.closed).length,
    backfilled,
    ms: Date.now() - started,
  };
}

export type Series = {
  id: string;
  question: string;
  url: string | null;
  endDate: string | null;
  closed: boolean;
  /** Latest odds in the range, and the change since its first point. */
  current: number | null;
  change: number | null;
  points: { t: string; p: number }[];
};

export type SeriesResult = {
  range: Range;
  bucketSeconds: number;
  from: string;
  to: string;
  markets: Series[];
  queryMs: number;
};

export function parseRange(value: string | null): Range | null {
  if (value === null || value === "") return "7d";
  return value in RANGES ? (value as Range) : null;
}

/** History of the given markets on one shared time axis, loading missing history first. */
export async function oddsSeries(
  ids: string[],
  range: Range,
  deps: OddsDeps = defaultOddsDeps,
): Promise<SeriesResult> {
  const rows = await ensureTracked(ids, deps);
  const now = deps.now();
  const { points, ms } = await deps.repo.series(
    rows.map((r) => r.id),
    range,
    now,
  );
  const round = (p: number) => Math.round(p * 10000) / 10000;
  const markets = rows.map((row) => {
    const own = points.filter((p) => p.marketId === row.id);
    const first = own[0]?.p ?? null;
    const last = own.at(-1)?.p ?? null;
    return {
      id: row.id,
      question: row.question,
      url: row.url,
      endDate: row.endDate,
      closed: row.closed,
      current: last === null ? null : round(last),
      change: first === null || last === null ? null : round(last - first),
      points: own.map((p) => ({ t: p.t.toISOString(), p: round(p.p) })),
    };
  });
  // Keep the caller's order.
  markets.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  return {
    range,
    bucketSeconds: RANGES[range].bucketSeconds,
    from: new Date(now.getTime() - RANGES[range].spanSeconds * 1000).toISOString(),
    to: now.toISOString(),
    markets,
    queryMs: ms,
  };
}
