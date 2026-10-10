# ProphETF plan (backend / API only)

**The product (re-planned 2026-10-09):** a stock basket picked by Gemini (`POST /api/stocks`), weighted by
Polymarket odds moves (`POST /api/weights`), with the odds behind it saved, tracked and charted in Tiger.
The older plan (paper ETFs made of Polymarket outcomes, NAV, leaderboard) is dropped.

Roles since 2026-10-10: Lucas owns the **decider** (Gemini makes the final stock decision), a backend teammate
owns the **analyst** (Polymarket data → evidence packet, see `docs/HANDOFF.md`), a frontend teammate owns the
UI. No UI pages are built here. Every endpoint goes into
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

## Step 3c — Decision workflow: analyst → gate → decider → checker (done, live)

Follows Anthropic's "Building effective agents": a workflow (fixed code path), not an autonomous agent.

- [x] `EvidencePacket` contract: zod + type in `src/lib/analyst/packet.ts`, `docs/API.md` section 1b, `docs/HANDOFF.md` with a full example and the two integration options
- [x] `src/lib/pipeline/`: `gate.ts`, `decider.ts` (the prompt), `checker.ts`, `run.ts` (the workflow), `handler.ts` (HTTP)
- [x] Mock analyst from existing code (Polymarket search, universe links, Tiger odds history), no LLM; `ANALYST_MODE=mock|module|tiger`; a failing real analyst falls back to the mock
- [x] Migration `0007_analyst.sql`: `analyst_packets`, `market_analysis` (HANDOFF option B)
- [x] `/api/stocks` runs the workflow; response unchanged plus `trace`; `422 not_enough_evidence` from the gate
- [x] `POST /api/analyze` (packet only) and `POST /api/decide` (idea + packet)
- [x] Quota: 1 Gemini call per uncached request, 2 at most; 8 uncached requests per minute may reach Gemini (worst case 16 calls per minute); `CHECKER_LLM=false`
- [x] `pnpm eval:decider`: 10 ideas with fixed packets; baseline on 2026-10-10: 9/9 first-answer pass, 9/9 grounded, gate case stopped, median 2.9 s (main model), 1.7 s (lite). First prompt change made with it: the backup model pasted market questions into every reason (29 of 29); after the change 0 of 31
- [ ] **Lucas:** check the daily limit of `gemini-3.5-flash` in AI Studio: after about 45 calls on 2026-10-10 every call got 429 and the lite model answered instead
- [ ] **Teammate:** choose option A (TypeScript module) or B (Python job → Tiger) and build the real analyst
- [ ] **Lucas:** when the real analyst is ready, set `ANALYST_MODE` on Vercel (`npx vercel env add ANALYST_MODE production`) and redeploy

## Step 4 — Sponsor APIs (each behind a flag with a mock)

**Solana (b) and Presage (d) are on hold until the decision workflow has its real analyst (Lucas, 2026-10-10).**

Sponsors in use: Tiger Data, Gemini, ElevenLabs, Solana, Presage (plus the GoDaddy domain). **Snowflake is
not used**: no keys, no endpoint, not listed in `/api/built-with`, and it must not appear in the Devpost text.

- [x] a. ElevenLabs (LIVE, `FEATURE_ELEVENLABS=true` on Vercel and locally): `POST /api/baskets/{id}/narrate` reads the manager's note (company names, rounded weights) with `eleven_flash_v2_5`; MP3 stored once per basket in Tiger (`briefings`), served with range support from `GET /api/audio/{id}`; script-only answer when ElevenLabs is off, fails or the daily budget (30 new briefings) is used; `getBasketNarration` in the adapter; proof in `/api/built-with`
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
- [ ] Step 4: fund the Solana devnet attester, Presage key
