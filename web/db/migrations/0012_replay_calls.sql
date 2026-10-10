-- Every Gemini call of the track-record replay (src/lib/track/), kept for good: running the
-- replay again reads the answers from here and costs no quota. key = sha256 of the task, the
-- system prompt, the prompt and the schema.
create table if not exists replay_calls (
  key text primary key,
  label text not null,
  model text not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);
