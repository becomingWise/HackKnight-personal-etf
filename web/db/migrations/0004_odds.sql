-- migrate:no-transaction
-- Odds history: every Polymarket probability ProphETF observes, kept in a TimescaleDB hypertable.

-- Markets we have seen: candidates of /api/stocks, signals of /api/weights, markets cited by baskets.
create table if not exists markets (
  id text primary key,
  question text not null,
  url text,
  -- Outcome token of "Yes": positionIds[0] on v2 markets, clobTokenIds[0] on v1.
  yes_token_id text,
  end_date timestamptz,
  closed boolean not null default false,
  first_seen_at timestamptz not null default now(),
  last_tick_at timestamptz,
  -- Set once 30 days of history have been loaded from Polymarket's Data API.
  backfilled_at timestamptz
);

-- migrate:split
create table if not exists odds_ticks (
  time timestamptz not null,
  market_id text not null,
  outcome text not null default 'Yes',
  probability double precision not null check (probability >= 0 and probability <= 1),
  -- 'stocks' | 'weights' | 'basket' | 'tick' | 'backfill'
  source text not null,
  unique (market_id, outcome, time)
) with (
  tsdb.hypertable,
  tsdb.partition_column = 'time',
  tsdb.chunk_interval = '7 days',
  tsdb.segmentby = 'market_id',
  tsdb.orderby = 'time desc'
);

-- migrate:split
-- The hypertable comes with a default columnstore policy (7 days); convert after 1 day instead.
call remove_columnstore_policy('odds_ticks', if_exists => true);

-- migrate:split
call add_columnstore_policy('odds_ticks', after => interval '1 day', if_not_exists => true);

-- migrate:split
-- Hourly candles per market. Real-time: buckets newer than the last refresh are computed on read.
create materialized view if not exists odds_1h
with (timescaledb.continuous, timescaledb.materialized_only = false) as
select
  time_bucket('1 hour', time) as bucket,
  market_id,
  outcome,
  first(probability, time) as open,
  max(probability) as high,
  min(probability) as low,
  last(probability, time) as close,
  count(*) as ticks
from odds_ticks
group by 1, 2, 3
with no data;

-- migrate:split
-- 35 days back so that 30-day backfills of newly seen markets are materialized too.
select add_continuous_aggregate_policy(
  'odds_1h',
  start_offset => interval '35 days',
  end_offset => interval '1 hour',
  schedule_interval => interval '15 minutes',
  if_not_exists => true
);
