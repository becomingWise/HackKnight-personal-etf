# ProphETF plan (backend / API only)

**The product (re-planned 2026-10-09):** a stock basket picked by Gemini (`POST /api/stocks`), weighted by
Polymarket odds moves (`POST /api/weights`), with the odds behind it saved, tracked and charted in Tiger.
The older plan (paper ETFs made of Polymarket outcomes, NAV, leaderboard) is dropped.

Lucas owns the backend; a teammate owns the frontend. No UI pages are built here. Every endpoint goes into
`docs/API.md` with request and response examples.

After each step: tests, `npx vercel --prod --yes` from `/web`, update `docs/API.md` + `/CLAUDE.md` + this
file, and a short note Lucas can forward to the frontend teammate.

## Done

- [x] Scaffold: Next.js 16 in `/web`, env validation, sponsor flags with mocks, Tiger client, migration runner, `GET /api/health`
- [x] Tiger Cloud service `prophetf` (`v5idwzv5iv`), deployed at https://prophetf.vercel.app
- [x] findStocks: `POST /api/stocks` (+ alias `/api/findstock`), Gemini picks backed by live Polymarket odds, fallback, CORS, rate limits, contract tests, `/js/stocks-adapter.js`

## Step 1 — End-to-end flow: idea → stocks → weights on live URLs (done)

- [x] Found: `POST /api/weights` ran nowhere public (local FastAPI in `/backend`); no frontend weights adapter existed
- [x] Lucas chose: port to a TypeScript route in `/web`; the Python engine stays the reference; `/backend` untouched
- [x] `POST /api/weights` (`src/lib/weights/`): same request/response as Python, CORS, rate limit
- [x] Tests: the cases of `backend/tests/test_engine.py` and `test_weights_api.py`, 88 golden requests replayed through the real Python app (`pnpm parity:weights`), and the team's `validateAdjustment`
- [x] `/js/weights-adapter.js` (not wired in) + "switching from mocks" section in `docs/API.md`
- [x] Deployed; full flow verified through the team's real controller against https://prophetf.vercel.app
- [ ] Open: the method owner may object to the port → fallback is deploying the Python app (option 2)
- [ ] Open: GitHub Pages is down (404); offer to serve the static frontend from this Vercel project (not built)
- [ ] Do not merge `main` yet (Lucas, 2026-10-09)

## Step 2 — Saved baskets (Tiger)

- [ ] Migration: `baskets` (short id, idea, summary, stocks, weights, cited market ids, odds at creation, created_at)
- [ ] `POST /api/baskets` → `{ id, url }`; `GET /api/baskets/{id}`
- [ ] zod validation, rate limit, CORS, tests
- [ ] Adapter docs: how the frontend saves and loads a basket

## Step 3 — Odds history (Tiger showcase)

- [ ] `odds_ticks` hypertable (time, market_id, outcome, probability), unique (market_id, outcome, time), columnstore policy
- [ ] `markets` table for cited markets (id, question, url, token ids, end date, resolved)
- [ ] Every `/api/stocks` call records the odds it observed
- [ ] `POST /api/jobs/tick` (cron, `CRON_SECRET`): refresh odds every minute for all markets cited by saved baskets; `pnpm jobs:loop`
- [ ] `odds_1h` continuous aggregate + refresh policy
- [ ] `GET /api/markets/{id}/history?range=1d|7d|30d`, backfilled from Data API v2 `prices-history` the first time a market is seen
- [ ] `GET /api/baskets/{id}/odds`: all cited markets' history in one call
- [ ] Query latency recorded for `GET /api/built-with`
- [ ] cron-job.org URL and schedule handed to Lucas

## Step 4 — Sponsor APIs (each behind a flag with a mock)

- [ ] a. ElevenLabs: `POST /api/baskets/{id}/narrate` → MP3 briefing of the summary and key odds, cached in Tiger; `GET /api/audio/{id}`
- [ ] b. Solana devnet: `POST /api/baskets/{id}/publish` → memo tx with the basket hash + odds snapshot; `GET /api/baskets/{id}/verify`
- [ ] c. Snowflake Cortex: `POST /api/baskets/{id}/letter` → short "manager's note"
- [ ] d. Presage: `POST /api/tilt-check` (mock first) the frontend can call before saving a basket

## Step 5 — `GET /api/built-with`

- [ ] JSON proof per sponsor: row counts, last tick, query latencies, attestation links, briefing and letter counts, tilt checks

## Later / optional

- [ ] Candidates for `/api/stocks` from Tiger + pgvector instead of live search
- [ ] Custom GoDaddy domain on Vercel + DNS records
- [ ] README backend sections, `DEVPOST.md` backend paragraphs, `docs/DEMO.md` backend notes

## Needs from Lucas

- [ ] The GitHub Pages site is down (404): someone with access must republish it (frontend owner)
- [ ] Step 4: ElevenLabs key + voice id, Snowflake account URL + PAT, fund the Solana devnet attester, Presage key
