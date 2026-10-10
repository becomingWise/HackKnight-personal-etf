-- Per-model Gemini budgets, shared by every server instance (src/lib/gemini/).

-- Calls reserved per model and period. period is 'm:2026-10-10T14:47' (a UTC minute) or
-- 'd:2026-10-10' (a day in Pacific time, which is how Google counts the daily quota).
create table if not exists gemini_usage (
  model text not null,
  period text not null,
  calls integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (model, period)
);

-- A model that must not be tried again before a given time: after a 429 (until the minute or the
-- Pacific day ends) or after a 404 from a retired model (a day).
create table if not exists gemini_blocks (
  model text primary key,
  blocked_until timestamptz not null,
  reason text not null
);
