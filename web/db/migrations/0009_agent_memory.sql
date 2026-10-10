-- Session memory of the stock agent (../agent/memory.js): the preferences a person stated and the
-- baskets they were given, keyed by the X-Session-Id the browser sends (one per tab).

create table if not exists agent_memory (
  session_id text primary key,
  preferences jsonb not null default '[]',
  baskets jsonb not null default '[]',
  updated_at timestamptz not null default now()
);

-- Sessions are short-lived; old rows are deleted now and then by the app.
create index if not exists agent_memory_updated_at on agent_memory (updated_at);
