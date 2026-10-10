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

## Step 2 — Saved baskets (done, live)

- [x] Migration `0003_baskets.sql`: `baskets` (short id, idea, summary, source, stocks, weights, cited markets with odds at creation, market ids)
- [x] `POST /api/baskets` accepts the `/api/stocks` + `/api/weights` responses as-is → basket with `id` and share `url`
- [x] `GET /api/baskets/{id}` and `GET /b/{id}` (JSON for now; the page is the frontend's job)
- [x] zod validation, 64 KB limit, rate limit, CORS (GET allowed), tests incl. the adapter round trip
- [x] `/js/baskets-adapter.js`: `saveBasket`, `getBasket`, `basketFromState` (not wired in), documented
- [x] Found and fixed during testing: Gemini free-tier per-minute quota (429) silently triggered the keyword fallback → backup model `gemini-3.5-flash-lite`, planning step moved to the lite model, better keyword fallback

## Step 3 — Odds history in Tiger (done, live)

- [x] Migration `0004_odds.sql`: `markets`, `odds_ticks` hypertable (unique market/outcome/time, columnstore segmented by market after 1 day), `odds_1h` real-time continuous aggregate + refresh policy
- [x] Every `/api/stocks` call records its candidate markets' odds; `/api/weights` records its signals; saving a basket records the odds at creation
- [x] `POST /api/jobs/tick` (`CRON_SECRET`): one tick per minute per open market cited by a saved basket, idempotent; `pnpm jobs:loop`
- [x] Backfill from Data API v2 `prices-history` the first time a market is seen (30 days hourly + 1 day at 10 minutes)
- [x] `GET /api/markets/{id}/history?range=1d|7d|30d` and `GET /api/baskets/{id}/odds` (one `time_bucket_gapfill` + `locf` query for all markets)
- [x] `GET /api/built-with`: Tiger row counts, hypertable/columnstore stats, policy jobs, live query latencies (other sponsors in step 4/5)
- [x] `getBasketOdds` / `getMarketHistory` in `/js/baskets-adapter.js`
- [ ] **Lucas:** schedule the tick on cron-job.org (URL and header in the step 3 message); until then nothing ticks every minute

## Step 3b — Demo reliability without Gemini billing (done, live)

- [x] Migration `0005_api_cache.sql`; `/api/stocks` and `/api/weights` answers cached in Tiger for 15 minutes for identical normalized requests; `cached` / `cachedAt` in the body, `X-Cache` / `X-Cache-Age` headers
- [x] `/api/jobs/warm` + `pnpm demo:warm [--loop|--status]`: pre-computes the 4 demo ideas (stocks and the follow-up weights request) and keeps them warm; a failed refresh keeps the previous AI answer
- [x] Measured free-tier limits: `gemini-3.5-flash` 5 requests/minute, `gemini-3.5-flash-lite` 15/minute (daily limits only visible in AI Studio)
- [ ] **Lucas:** check the daily request limits at https://aistudio.google.com/rate-limit

## Step 4 — Sponsor APIs (each behind a flag with a mock)

Sponsors in use: Tiger Data, Gemini, ElevenLabs, Solana, Presage (plus the GoDaddy domain). **Snowflake is
not used**: no keys, no endpoint, not listed in `/api/built-with`, and it must not appear in the Devpost text.

- [ ] a. ElevenLabs: `POST /api/baskets/{id}/narrate` → MP3 briefing of the summary and key odds, cached in Tiger; `GET /api/audio/{id}`
- [ ] b. Solana devnet: `POST /api/baskets/{id}/publish` → memo tx with the basket hash + odds snapshot; `GET /api/baskets/{id}/verify`
- [x] c. Manager's note: `POST /api/baskets/{id}/letter`, written by Gemini (Snowflake was dropped on 2026-10-09), cached per basket, template fallback, numbers checked against the basket; `getBasketLetter` in the adapter
- [ ] d. Presage: `POST /api/tilt-check` (mock first) the frontend can call before saving a basket

## Step 5 — `GET /api/built-with`

- [x] Tiger and Gemini sections (built in step 3)
- [ ] Per-sponsor proof for step 4: attestation links, briefing counts, tilt checks (letter counts are already under `gemini`)

## Later / optional

- [ ] Candidates for `/api/stocks` from Tiger + pgvector instead of live search
- [ ] Custom GoDaddy domain on Vercel + DNS records
- [ ] README backend sections, `DEVPOST.md` backend paragraphs (no "How we used Snowflake" section; the manager's note is a Gemini feature), `docs/DEMO.md` backend notes

## Needs from Lucas

- [ ] Schedule `POST https://prophetf.vercel.app/api/jobs/tick` every minute on cron-job.org with header `Authorization: Bearer <CRON_SECRET from web/.env.local>`
- [ ] The GitHub Pages site is down (404): someone with access must republish it (frontend owner)
- [ ] Step 4: ElevenLabs key + voice id, fund the Solana devnet attester, Presage key
