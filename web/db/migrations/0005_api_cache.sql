-- Response cache shared by all server instances (Vercel functions do not share memory).
-- Used by /api/stocks and /api/weights so repeated requests do not spend Gemini quota.
create table if not exists api_cache (
  -- 'stocks' | 'weights'
  kind text not null,
  -- sha256 of the normalized request
  key text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  primary key (kind, key)
);

create index if not exists api_cache_expires_at_idx on api_cache (expires_at);
