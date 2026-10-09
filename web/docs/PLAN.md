# ProphETF plan

Checklist of the phases in section 8 of the brief (`/CLAUDE.md`). Tick items as they are finished.
At the end of every phase: run tests, push (Vercel deploys), update CLAUDE.md + this file, 5-line summary.

## Section 0 — First actions

- [x] Brief saved to `/CLAUDE.md` with Status + Decisions
- [x] `docs/PLAN.md` (this file)
- [x] `.env.example`
- [x] Tiger Cloud service created (`prophetf`, `v5idwzv5iv`, us-east-1, free) and `DATABASE_URL` written to `.env.local`

## Phase 0 — Scaffold

Done when: the Vercel URL shows health OK.

- [x] Next.js app in `/web` (Next 16, App Router, TypeScript, Tailwind 4, pnpm)
- [x] Lint + format (eslint, prettier), typecheck, vitest
- [x] Env loading validated with zod (`src/lib/env.ts`) and sponsor flags with mock fallback (`src/lib/flags.ts`)
- [x] DB client singleton, max 3 connections (`src/lib/db/client.ts`)
- [x] Migration runner (`pnpm db:migrate`, `pnpm db:status`) + `0001_extensions.sql`
- [x] `/api/health` (DB + every flag)
- [x] Layout with the required footer on every page
- [ ] First Vercel deploy — **user: import the repo into Vercel** (see below)
- [ ] Vercel URL shows health OK

## Phase 1 — Data core

Done when: ≥ 500 markets, prices landing every minute, `/markets` loads fast.

- [ ] Verify Polymarket docs (SDK `@polymarket/client`, Gamma keyset, CLOB midpoints/last-trades, Data API v2 history, v1/v2 IDs)
- [ ] Schema migration: markets, market_embeddings, price_ticks hypertable + columnstore policy, price_1h cagg + refresh policy, etfs, etf_holdings, etf_events, etf_nav hypertable + etf_nav_1h cagg, briefings, tilt_checks
- [ ] `src/lib/polymarket` wrapper with zod validation, batching, 429 backoff
- [ ] `/api/jobs/sync-markets` (top ~1,500 by volume/liquidity, v1/v2 IDs, resolution status)
- [ ] `/api/jobs/tick` (poll-prices for held + top 200; compute-nav stub)
- [ ] `CRON_SECRET` auth on jobs; `pnpm jobs:loop`
- [ ] Backfill 30 days from Data API v2
- [ ] `/markets` with keyword search, filters, YES price and sparklines
- [ ] shadcn/ui + lightweight-charts set up
- [ ] cron-job.org URLs and schedules handed to the user

## Phase 2 — ETF engine

Done when: I can create an ETF and watch its NAV move on the deployed site.

- [ ] `src/lib/etf` pure math + vitest (inception NAV = C0, win/loss/50-50, rebalance preserves NAV, NO side, validation)
- [ ] Anonymous `owner_id` cookie, owner-only edits
- [ ] Manual builder at `/build` with preview stats (and the what-if slider idea from MyETF)
- [ ] Factsheet `/etf/[ticker]`: stats, NAV chart, holdings table, sector donut, event timeline, Rebalance
- [ ] `/api/etf/[ticker]/live` polled every 15 s
- [ ] NAV computation in the tick job; resolution handling
- [ ] SQL backtest (time_bucket_gapfill + locf), labelled "Simulated"
- [ ] `/leaderboard` (AI-built vs hand-built filter)
- [ ] Seed $AIBULL, $SOFTLND, $CHAOS with 30-day simulated history
- [ ] Landing page with three featured ETFs and sparklines

## Phase 3 — AI Fund Architect

Done when: thesis → valid ETF in under 30 s.

- [ ] Verify Gemini docs (model id, embedding model, 768 dims, structured output)
- [ ] Embeddings job (`enrich`) + HNSW/diskann index
- [ ] Semantic search on `/markets`
- [ ] Pipeline: thesis → claims/queries → candidates → basket JSON, zod validate, retry once
- [ ] Streamed progress steps, editable preview, backtest toggle
- [ ] Per-owner rate limit on AI endpoints

## Phase 4 — Light touches (in order, each behind a flag with a mock)

- [ ] 1. ElevenLabs "Morning Bell" (script by Gemini, MP3 in `briefings`, `/api/audio/[id]`)
- [ ] 2. Solana devnet attestations (memo tx, Phantom sign-in, Verify button, explorer links)
- [ ] 3. Snowflake Cortex "Sector desk" (sector classification, daily fund letter)
- [ ] 4. Presage "Tilt check" (mock first; report simplest real path)
- [ ] Stretch: `scripts/ws-listener.ts`, Token-2022 share certificate

## Phase 5 — Ship

- [ ] 5. GoDaddy domain on Vercel + DNS records for the user
- [ ] Loading / empty / error states, mobile layout
- [ ] `/built-with` live proof per sponsor
- [ ] README (Mermaid architecture, setup, per-sponsor notes)
- [ ] `DEVPOST.md` draft
- [ ] `docs/DEMO.md` 2-minute script

## Needs from the user

- [ ] **Now:** import the GitHub repo into Vercel (Root Directory `web`, branch `prophetf-app`) and add env vars — see the Phase 0 summary.
- [ ] Phase 1: nothing new (a `CRON_SECRET` is generated locally; copy it into Vercel and cron-job.org).
- [ ] Phase 3: `GEMINI_API_KEY` — already in `.env.local`; add it to Vercel too.
- [ ] Phase 4: ElevenLabs key + voice id, Snowflake account URL + PAT, fund the Solana devnet attester, Presage key (if a real path is chosen).
- [ ] Phase 5: register the GoDaddy domain.
