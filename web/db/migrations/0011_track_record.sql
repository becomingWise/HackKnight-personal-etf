-- The voting panel's track record (src/lib/track/).

-- Daily adjusted closes of the 40 universe tickers and SPY, loaded by `pnpm closes:load`
-- (a local script on top of backend/src/polyslice_api/prices.py; nothing on Vercel fetches prices).
create table if not exists stock_closes (
  symbol text not null,
  day date not null,
  close double precision not null,
  updated_at timestamptz not null default now(),
  primary key (symbol, day)
);
create index if not exists stock_closes_day_idx on stock_closes (day);

-- One panel decision on one basket: what was known that day, and one week later what happened.
create table if not exists panel_decisions (
  id bigint generated always as identity primary key,
  -- The day the panel decided (for a replay: the Friday whose close was the last thing it knew).
  day date not null,
  source text not null check (source in ('replay', 'live')),
  idea text not null,
  symbols text[] not null,
  -- Inputs known that day:
  --   { "signals": [{ "id", "label", "probability", "change7d" }],
  --     "returns": { "NVDA": { "r5": 0.012, "r20": -0.03 }, ... , "SPY": { ... } } }
  inputs jsonb not null default '{}'::jsonb,
  -- 'yes' (most agents expect the basket to beat SPY next week), 'no', or null for a tie.
  majority text check (majority in ('yes', 'no')),
  -- Filled in by the scoring query once the closes one week later are loaded.
  scored_day date,
  basket_return double precision,
  spy_return double precision,
  -- Paper profit or loss of $10,000 in the equal-weighted basket over that week.
  pnl double precision,
  majority_correct boolean,
  scored_at timestamptz,
  created_at timestamptz not null default now(),
  unique (source, day, idea, symbols)
);
create index if not exists panel_decisions_day_idx on panel_decisions (day desc);

-- Each agent's call on that decision.
create table if not exists panel_votes (
  decision_id bigint not null references panel_decisions (id) on delete cascade,
  -- The voter id of src/lib/votes/votes.ts: growth, value, macro, skeptic, fit.
  agent text not null,
  -- "Will this basket beat SPY over the next week?"
  vote text not null check (vote in ('yes', 'no')),
  -- The agent's probability that it will, 0 to 1.
  probability double precision not null check (probability >= 0 and probability <= 1),
  reason text not null default '',
  model text,
  -- yes is correct if the basket beat SPY, no if it did not. Null until scored.
  correct boolean,
  primary key (decision_id, agent)
);
