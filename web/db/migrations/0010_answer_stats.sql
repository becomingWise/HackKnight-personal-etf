-- What reusing answers saves (src/lib/savings/): per Pacific day and endpoint, how many answers
-- were served, how many needed new Gemini calls and how many were reused from the cache.
-- day is 'd:2026-10-10', the same key as the day rows of gemini_usage.
create table if not exists answer_stats (
  day text not null,
  endpoint text not null,
  answers integer not null default 0,
  new_answers integer not null default 0,
  reused integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (day, endpoint)
);
