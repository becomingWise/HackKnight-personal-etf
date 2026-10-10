-- Option B of docs/HANDOFF.md: the analyst (a Python job) writes into these two tables and the
-- decider reads them when ANALYST_MODE=tiger. Both are append/overwrite only; nothing else uses them.

-- A finished evidence packet for one idea. Insert a new row to refresh; the newest row wins.
create table if not exists analyst_packets (
  id bigint generated always as identity primary key,
  idea text not null,
  -- Lower case, single spaces: how the decider looks an idea up. Computed here, not by the writer.
  idea_key text generated always as (lower(btrim(regexp_replace(idea, '\s+', ' ', 'g')))) stored,
  -- The EvidencePacket JSON (web/src/lib/analyst/packet.ts).
  packet jsonb not null,
  generated_at timestamptz not null default now()
);

create index if not exists analyst_packets_idea_key_idx on analyst_packets (idea_key, generated_at desc);

-- Analysis of one market, independent of any idea. Used for ideas that have no packet: the
-- decider's own search finds the markets and these rows replace the mock's signal, note and tickers.
create table if not exists market_analysis (
  market_id text primary key,
  signal text not null check (signal in ('bullish', 'bearish', 'neutral')),
  analyst_note text not null,
  -- [{ "symbol": "TSM", "impact": -0.6, "why": "..." }], impact from -1 to 1
  tickers jsonb not null default '[]',
  analyzed_at timestamptz not null default now()
);
