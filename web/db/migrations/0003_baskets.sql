-- Saved baskets: the output of /api/stocks + /api/weights, shareable by a short id.
create table if not exists baskets (
  id text primary key,
  idea text not null,
  summary text not null,
  -- 'gemini' | 'fallback' | null (unknown: saved from a client that dropped the field)
  source text,
  -- [{symbol, name, reason, marketId, weightPct}]
  stocks jsonb not null,
  -- {status, explanation, holdings: [{symbol, weightPct}], evidence: [...]}
  weights jsonb not null,
  -- Cited markets with the odds observed at creation:
  -- [{id, title, url, outcome, probability, observedAt, change7d, citedBy}]
  markets jsonb not null default '[]',
  -- Polymarket market ids of the cited markets, for the tick job.
  market_ids text[] not null default '{}',
  -- Hashed IP of the creator, for abuse handling only.
  creator text,
  created_at timestamptz not null default now()
);

create index if not exists baskets_created_at_idx on baskets (created_at desc);
create index if not exists baskets_market_ids_idx on baskets using gin (market_ids);
