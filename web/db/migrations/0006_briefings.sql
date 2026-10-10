-- Audio briefings: one narrated MP3 per saved basket (a basket never changes), stored in Tiger
-- and served from /api/audio/{basket id}. Only real ElevenLabs audio is stored, never mocks.
create table if not exists briefings (
  basket_id text primary key references baskets (id) on delete cascade,
  script text not null,
  audio bytea not null,
  mime text not null default 'audio/mpeg',
  model text not null,
  -- Characters billed by ElevenLabs for this briefing, when reported.
  character_cost integer,
  created_at timestamptz not null default now()
);
