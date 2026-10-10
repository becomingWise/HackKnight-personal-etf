-- Fixed-window request counters for public endpoints (per hashed IP and global).
create table if not exists api_rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null default 0,
  primary key (bucket, window_start)
);
