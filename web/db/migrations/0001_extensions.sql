-- Extensions ProphETF relies on. TimescaleDB ships enabled on Tiger Cloud time-series services.
create extension if not exists timescaledb;
create extension if not exists vector;
create extension if not exists vectorscale cascade;
create extension if not exists pg_trgm;
