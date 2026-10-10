# ProphETF plan (backend / API only)

Team split since 2026-10-09: Lucas owns the backend (database, Polymarket ingestion, jobs, ETF math, API
routes under `src/app/api`). A teammate owns the frontend. No UI pages are built or redesigned here.
Every endpoint goes into `docs/API.md` with request and response examples.

At the end of every phase: run tests, deploy, update `/CLAUDE.md` + this file + `docs/API.md`, 5-line summary.

## Section 0 — First actions

- [x] Brief saved to `/CLAUDE.md` with Status + Decisions
- [x] `docs/PLAN.md` (this file)
- [x] `.env.example`
- [x] Tiger Cloud service created (`prophetf`, `v5idwzv5iv`, us-east-1, free) and `DATABASE_URL` written to `.env.local`

## Phase 0 — Scaffold

- [x] Next.js app in `/web` (Next 16, App Router, TypeScript, Tailwind 4, pnpm)
- [x] Lint + format, typecheck, vitest
- [x] Env validation (`src/lib/env.ts`) and sponsor flags with mock fallback (`src/lib/flags.ts`)
- [x] DB client singleton, max 3 connections (`src/lib/db/client.ts`)
- [x] Migration runner (`pnpm db:migrate`, `pnpm db:status`) + `0001_extensions.sql`
- [x] `GET /api/health`
- [x] First Vercel deploy, health OK on https://prophetf.vercel.app/api/health

## Priority 1 — findStocks (done, live)

- [x] Read `lucas-branch`, find every findStocks call, write the contract to `docs/API.md`
- [x] Decisions from Lucas: stocks per the contract with Polymarket evidence, 40-ticker universe, 3 to 5 stocks, work on `lucas-branch`
- [x] `POST /api/stocks` + alias `POST /api/findstock`: zod input, Gamma search candidates, Gemini (`gemini-3.5-flash`, structured output), zod output, fabricated markets dropped, odds verified, one retry
- [x] Keyword fallback when Gemini fails or exceeds 20 s (`source: "fallback"`)
- [x] CORS for the frontend origins + `OPTIONS`
- [x] Rate limit per IP and global, counters in Tiger (`api_rate_limits`)
- [x] Contract tests with mocked Gemini, including the team's real `js/controller.js`
- [x] `/js/stocks-adapter.js` for the frontend teammate (not wired in)
- [x] Deployed with `npx vercel --prod`: https://prophetf.vercel.app/api/stocks
- [ ] Later: use the Tiger `markets` table + pgvector for candidates once Phase 1 and 3 data exists

## Phase 1 — Data core

Done when: ≥ 500 markets in Tiger and prices landing every minute.

- [ ] Verify Polymarket docs (SDK `@polymarket/client`, Gamma keyset, CLOB midpoints/last-trades, Data API v2 history, v1/v2 IDs)
- [ ] Schema migration: markets, market_embeddings, price_ticks hypertable + columnstore policy, price_1h cagg + refresh policy, etfs, etf_holdings, etf_events, etf_nav hypertable + etf_nav_1h cagg, briefings, tilt_checks
- [ ] `src/lib/polymarket` wrapper with zod validation, batching, 429 backoff
- [ ] `POST /api/jobs/sync-markets` (top ~1,500 by volume/liquidity, v1/v2 IDs, resolution status)
- [ ] `POST /api/jobs/tick` (poll-prices for held + top 200; compute-nav)
- [ ] `CRON_SECRET` auth on jobs; `pnpm jobs:loop`
- [ ] Backfill 30 days from Data API v2
- [ ] API the frontend needs: `GET /api/markets` (keyword search, filters: sector, tag, ends-by, min liquidity; YES price + sparkline points), `GET /api/markets/[id]`
- [ ] cron-job.org URLs and schedules handed to Lucas

## Phase 2 — ETF engine

Done when: an ETF can be created through the API and its NAV moves.

- [ ] `src/lib/etf` pure math + vitest (inception NAV = C0, win/loss/50-50, rebalance preserves NAV, NO side, validation)
- [ ] Anonymous `owner_id` cookie, owner-only writes
- [ ] API the frontend needs: `POST /api/etf/preview` (section 3 stats before creating), `POST /api/etf` (create), `GET /api/etf/[ticker]` (factsheet data: stats, holdings, sectors, events), `GET /api/etf/[ticker]/nav?range=1D|1W|1M|ALL`, `GET /api/etf/[ticker]/live` (polled every 15 s), `POST /api/etf/[ticker]/rebalance`, `GET /api/leaderboard?created_by=ai|human`
- [ ] NAV computation in the tick job; resolution handling
- [ ] SQL backtest (time_bucket_gapfill + locf), labelled "Simulated": `POST /api/etf/backtest`
- [ ] Seed $AIBULL, $SOFTLND, $CHAOS with 30-day simulated history; `GET /api/etf/featured`

## Phase 3 — AI Fund Architect (API)

Done when: thesis → valid ETF proposal in under 30 s.

- [ ] Verify Gemini docs (model id, embedding model, 768 dims, structured output)
- [ ] Embeddings in the `enrich` job + HNSW/diskann index
- [ ] `GET /api/markets?mode=semantic`
- [ ] `POST /api/architect` — thesis → claims/queries → candidates → basket JSON, zod validate, retry once, progress steps streamed
- [ ] Per-owner rate limit on AI endpoints

## Phase 4 — Sponsor APIs (in order, each behind a flag with a mock)

- [ ] 1. ElevenLabs "Morning Bell": `POST /api/etf/[ticker]/briefing`, `GET /api/audio/[id]`
- [ ] 2. Solana devnet: `POST /api/wallet/link` (signed message), attest on publish / rebalance / daily job, `GET /api/etf/[ticker]/verify`
- [ ] 3. Snowflake Cortex: sector classification in `enrich`, `GET /api/etf/[ticker]/letter`
- [ ] 4. Presage: `POST /api/tilt-check` (mock first; report the simplest real path)
- [ ] Stretch: `scripts/ws-listener.ts`, Token-2022 share certificate

## Phase 5 — Ship (backend side)

- [ ] `GET /api/built-with` (row counts, last ingest, query latency, attestation links, briefing count, tilt checks)
- [ ] Custom domain on Vercel + DNS records for Lucas
- [ ] Consistent error shape and CORS on every public endpoint
- [ ] README backend sections (Mermaid architecture, setup, per-sponsor notes), `DEVPOST.md` backend paragraphs, `docs/DEMO.md` backend notes

## Needs from Lucas

- [ ] Phase 4: ElevenLabs key + voice id, Snowflake account URL + PAT, fund the Solana devnet attester, Presage key
- [ ] Phase 5: register the GoDaddy domain
