# ProphETF — working notes for Claude Code

> A fresh session should be able to resume from this file alone. Read **Status** and **Decisions** first, then the brief.
> The Next.js app lives in `/web`. All paths in the brief are relative to `/web` (Vercel Root Directory = `web`).
> Branch: `prophetf-app`. Never push to `main` without asking. Never touch the teammate's static app at the repo root
> (`index.html`, `css/`, `js/`, `data/`, `scripts/`, `tests/`, root `package.json`, `README.md`).

## Status

_Updated: 2026-10-09 (session 1)_

- **Current phase:** Phase 0 (Scaffold) built and verified locally (build, lint, typecheck, tests, `/api/health` 200). Blocked only on the first Vercel deploy (user imports the repo). Next: Phase 1 (Data core), starting with verifying the Polymarket docs.
- **Commands (run in `web/`):** `pnpm dev`, `pnpm build`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm format`, `pnpm db:migrate`, `pnpm db:status`.
- **Env:** `web/.env.local` has DATABASE_URL, GEMINI_API_KEY (user-provided), CRON_SECRET (generated locally), APP_BASE_URL and all FEATURE_* flags false. Other sponsor keys are still missing.
- **Shell note:** multi-file bash heredocs fail in this harness on Windows; create files with the Write tool.
- **Checklist:** `web/docs/PLAN.md`.
- **Tiger Cloud service:** `prophetf`, id `v5idwzv5iv`, us-east-1, free shared plan, DEV. `DATABASE_URL` is in `web/.env.local`.
- **Vercel:** not imported yet (user action).
- **Waiting on the user for:** see "Needs from the user" at the bottom of `web/docs/PLAN.md`.

## Decisions

| # | Date | Decision | Why |
|---|------|----------|-----|
| 1 | 2026-10-09 | `CLAUDE.md` sits at the real repo root; everything else (docs/PLAN.md, .env.example, app) under `/web`. | Claude Code loads the root CLAUDE.md on session start; the brief says app paths are relative to `/web`. |
| 2 | 2026-10-09 | pnpm installed with `npm i -g pnpm` (v12), not corepack. | `corepack enable` fails with EPERM on this Windows machine (Program Files not writable). |
| 3 | 2026-10-09 | Tiger service in `us-east-1`. | Closest to Vercel's default function region (iad1). |
| 4 | 2026-10-09 | DATABASE_URL written to `.env.local` by `tiger db uri --with-password` piped straight to the file. | Keeps the password out of the terminal and out of the session transcript. |
| 5 | 2026-10-09 | Keep the scaffold default `cacheComponents: true` (Next 16.4). Dynamic server reads call `await connection()` and sit inside `<Suspense>`. Read `web/node_modules/next/dist/docs` before using unfamiliar Next APIs (see `web/AGENTS.md`). | It is the current Next model: static shell plus streamed live data. |
| 6 | 2026-10-09 | Migrations run in one transaction per file; a file starting with `-- migrate:no-transaction` runs statement by statement, split on `-- migrate:split` lines. | Continuous aggregates cannot be created inside a transaction. |
| 7 | 2026-10-09 | A sponsor is "live" only when its flag is on AND its credentials are present; otherwise the mock is used (`src/lib/flags.ts`). | One missing key never breaks the demo. |
| 8 | 2026-10-09 | shadcn/ui and lightweight-charts get installed in Phase 1 with the first real UI, not in Phase 0. | Keeps the scaffold minimal and the first deploy fast. |

## Docs-vs-brief discrepancies

_(Log here whenever a live doc disagrees with the brief; follow the docs.)_

- None yet. Verified so far: the Tiger service runs Postgres 18.6, TimescaleDB 2.30.2, pgvector 0.8.7 and pgvectorscale 0.9.0 (all enabled by migration 0001), so the diskann index option is available.

## Existing repo (teammate's work — read-only)

"MyETF — Personal portfolio lab": a static HTML/CSS/JS simulator on GitHub Pages (`gh-pages`, published by `scripts/publish_pages.py`).
Pick 3–5 fictional companies, set weights (must total 100%) and a pretend budget, then move per-company sliders to see a what-if value.
- `js/portfolio.js`: pure functions `validateBasket`, `equalWeightHoldings`, `calculateBasket`, `applyScenario`; tested with `node --test`.
- `js/ui.js`, `js/app.js`: DOM rendering and a small dispatch/state loop; JSON export.
- `data/assets.json`: six made-up companies across three interests.
- `css/styles.css`: light theme — bg `#f6f7fb`, ink `#202940`, muted `#6b7386`, line `#e7eaf1`, blue `#4057db`, radius 18px, Inter, sidebar + panel layout, "step label" eyebrows.

Reused in ProphETF: pure-function math module with readable validation errors, "Equal weights" repair, the what-if slider idea
(per-holding price scenario on the builder preview), the numbered step labels and the colour palette / panel styling.

---

# ProphETF: personal ETFs built from Polymarket data (the brief, verbatim)

Context: a 36-hour MLH hackathon, submitted on Devpost. Sponsor prize tracks we're targeting: Tiger Data, Google Gemini API, Solana, Snowflake, ElevenLabs, Presage, GoDaddy Registry. Judges look for real, visible use of each sponsor. You are my senior full-stack engineer. I'm on Windows (PowerShell). Optimize for a reliable, impressive live demo over completeness, keep the app deployable at all times, and commit after every working step.

## 0. First actions (before any app code)
1. Save this whole brief to CLAUDE.md at the repo root, then add a "Decisions" log and a "Status" section and keep both current so a fresh session can resume from CLAUDE.md alone.
2. Write docs/PLAN.md as a checklist of the phases in section 8 and tick items off as you finish them.
3. Create .env.example from section 9. My real values go in .env.local (git-ignored). Never invent keys, never print secrets, and ask me for anything missing when a phase needs it.
4. If the Tiger MCP server is connected, create a free Tiger Cloud service for this project and write its connection string to .env.local as DATABASE_URL. If you can't, tell me what to do.
5. Start Phase 0. At the end of every phase: run tests, push so Vercel deploys, update CLAUDE.md and PLAN.md, and give me a 5-line summary plus anything I must do by hand.

## 1. Hard rules
- Polymarket is a READ-ONLY data source. Never call order, trading or auth endpoints; never create Polymarket keys or wallets.
- No real money anywhere. Every ETF is a paper portfolio. Solana is devnet only.
- Footer on every page: "Paper portfolios for research and fun. Not investment advice. Not affiliated with Polymarket."
- Every sponsor integration sits behind a feature flag with a mock fallback, so one failing API never breaks the core demo.
- The API notes below were checked in October 2026, but verify each against its live docs before coding it. If the docs disagree with this brief, follow the docs and log it in CLAUDE.md.
- Secrets live in .env.local locally and in Vercel Environment Variables in production. Nothing secret in NEXT_PUBLIC_ vars.
- Scripts must work on Windows (no bash-only commands in package.json).
- If something stalls for ~45 minutes, stop and give me 2–3 options. Ask before adding heavy dependencies or changing the architecture.

## 2. Product
Anyone can build a "personal ETF": a weighted basket of Polymarket outcomes (YES or NO on specific markets), valued live from Polymarket prices.
- `/` landing: pitch, three featured ETFs with live sparklines, "Build your ETF" button.
- `/markets` browser: keyword + semantic search, filters (sector, tag, ends-by, min liquidity), YES price and sparkline per market, "Add YES / Add NO" to the draft ETF.
- `/build`: Manual mode (pick markets, set weights) and AI Fund Architect mode (plain-English thesis → proposed basket to review and edit). The preview shows the section 3 stats before creating.
- `/etf/[ticker]` factsheet styled like a real ETF page: name, $TICKER, thesis, inception date, key stats, NAV chart (1D/1W/1M/ALL, live), holdings table (side, target vs current weight, entry → current price, contribution, resolves in, sector chip), sector donut, event timeline (created, rebalances with tilt badge, resolutions, Solana attestations with explorer links), audio briefing player, fund letter, Rebalance button.
- `/leaderboard`: public ETFs ranked by return since inception, filter AI-built vs hand-built.
- `/built-with`: live proof per sponsor (row counts, last ingest time, query latency, attestation links, briefing count, tilt checks).
- No login: issue an anonymous owner_id cookie. Only the owner (cookie or linked Solana wallet) can edit an ETF. Rate-limit AI and audio endpoints per owner.

## 3. ETF math (pure functions in src/lib/etf with unit tests)
- A holding is one outcome asset (the YES or NO side of a market) with target weight w. 3–15 holdings, each w ≤ 0.25, Σw = 1 (an explicit cash weight is allowed).
- Reference price p(t) in [0,1]: the midpoint; if the spread is > 0.10 or the book is empty, use the last trade price (confirm this display convention in Polymarket's prices docs). Never-traded assets come back as a 0.5 placeholder with an empty side (or are omitted from batch calls): treat them as missing. A resolved asset's price is its payout (1, 0, or 0.5 for a 50/50 resolution).
- Inception at t0 with paper capital C0 = 10,000: units q = w·C0 / p(t0). Reject outcomes priced below 0.02 or above 0.98 at entry.
- NAV(t) = cash + Σ over open holdings of q·p(t). Index level = 100·NAV / C0.
- Resolution: cash += q·payout and the holding closes. Cash stays cash until the next rebalance.
- Rebalance at t: q' = w'·NAV(t) / p(t), so a rebalance never changes NAV. Log before/after in etf_events.
- Stats: return since inception, 1D, 7D, max drawdown, holdings count, average days to resolution, "Payoff if every call is right" = cash + Σq (in $ and ×), "Implied odds every call is right" = Πp (labelled "assumes independence"), and a tooltip explaining that because prices are probabilities, NAV is the market's expected payoff.
- Backtest: same weights, inception 30 days ago at historical prices, hourly NAV with last-value carry-forward; only markets that existed then. Always labelled "Simulated".
- Tests (vitest): inception NAV = C0, win/loss/50-50 resolution, rebalance preserves NAV, NO-side pricing, validation errors.

## 4. Stack and architecture
- One Next.js app at the repo root (latest stable, App Router, TypeScript, Tailwind, shadcn/ui, TradingView lightweight-charts), pnpm, vitest. Shared logic in src/lib: etf/ (math), polymarket/ (client wrapper), db/ (queries), sponsors/ (one module per sponsor with its mock). Validate all external payloads with zod.
- DB: Tiger Cloud (Postgres + TimescaleDB + pgvector) through the `postgres` npm client as a module-level singleton with max 3 connections (the free plan has no connection pooler and Vercel runs many instances). Plain SQL migrations in db/migrations, run by a pnpm script.
- Hosting: Vercel free plan, deployed from GitHub on every push. Tell me when to import the repo into Vercel and exactly which env vars to add there.
- Jobs: API routes under /api/jobs/* — tick (poll-prices + compute-nav) every minute, sync-markets + enrich every 15 minutes, attest daily. Each requires `Authorization: Bearer <CRON_SECRET>`, is idempotent, and finishes well under 60 s. I'll schedule them on cron-job.org, so give me the URLs and schedules. Also add a `pnpm jobs:loop` script that runs the same jobs on a timer for local development.
- Audio: store ElevenLabs MP3s as bytea in Tiger and serve them from /api/audio/[id] with caching headers.
- Live UI: the factsheet polls /api/etf/[ticker]/live every 15 s. Stretch: a Polymarket WebSocket listener as a local script (scripts/ws-listener.ts) that I run on my laptop during the demo, writing ticks to Tiger.
- No Google Cloud project: Gemini is called directly with GEMINI_API_KEY.
- If the Tiger MCP server is connected, use it to inspect the service, run migrations and look up TimescaleDB docs.

## 5. Polymarket (read-only, no auth needed)
- Prefer the official unified TypeScript SDK `@polymarket/client` with `createPublicClient()` (listMarkets/listEvents paginators, fetchMidpoints, listPriceHistory, subscribe). Wrap it in src/lib/polymarket; call Gamma REST directly for fields the SDK doesn't expose (volume, liquidity, endDate, tags, image).
- IDs changed in 2026: every market has `version`. v2 markets put outcome IDs in `positionIds` (an array); v1 markets put them in `clobTokenIds` (a JSON-encoded string). `outcomes` is JSON text too. Never assume clobTokenIds exists. Resolution: v2 uses `resolutionStatus` (inactive/active/resolved), v1 uses `umaResolutionStatus`.
- REST: Gamma https://gamma-api.polymarket.com → /markets/keyset?closed=false&limit=100 (pass next_cursor back as after_cursor), /markets/{id}, /events/keyset, /public-search?q=, /tags. CLOB https://clob.polymarket.com → POST /midpoints and POST /last-trades-prices with body [{"token_id": "<asset_id>"}] (≤ 500 per call), GET /book?token_id=. History: https://data-api.polymarket.com/v2/prices-history?token_id=…&interval=1d|1w|1m|max&bucket_seconds=… (or start/end spanning ≤ 15 days), paginate with cursor. Buckets finer than 3h only reach back ~30 days; `max` defaults to 12h buckets.
- WebSocket (stretch): wss://ws-subscriptions-clob.polymarket.com/ws/market; send {"assets_ids":[…],"type":"market","custom_feature_enabled":true}; send the text frame PING every 10 s; handle price_change, best_bid_ask, last_trade_price, market_resolved.
- Scope: track the top ~1,500 active markets by volume/liquidity plus anything an ETF holds. Poll every minute for held assets + the top 200; everything else gets prices from the 15-minute catalog sync. Batch, cache, back off exponentially on 429s.

## 6. Tiger Data schema (show off TimescaleDB)
- markets(id PK, condition_id, version, question, slug, event_title, event_slug, tags text[], sector, end_date, volume, liquidity, yes_asset_id, no_asset_id, active, closed, resolved, winning_outcome, image_url, updated_at)
- market_embeddings(market_id PK, embedding vector(768)) with an HNSW cosine index (or pgvectorscale's diskann index if the service has it).
- price_ticks hypertable(time, asset_id, price, best_bid, best_ask, source), unique (asset_id, time), columnstore segmented by asset_id after 1 day, using the current TimescaleDB syntax.
- price_1h continuous aggregate (time_bucket 1h; first/max/min/last per asset) with a refresh policy; charts and sparklines read from it.
- etfs(id, ticker unique 2–7 letters, name, thesis, owner_id, wallet, created_by 'ai'|'human', inception_at, c0, cash, is_public, simulated_inception bool), etf_holdings(etf_id, market_id, side, asset_id, target_weight, units, entry_price, opened_at, closed_at, payout), etf_events(id, etf_id, type, at, payload jsonb, tilt jsonb, solana_sig).
- etf_nav hypertable(time, etf_id, nav, index_level) written by the tick job, plus an etf_nav_1h continuous aggregate for charts.
- Backtests in SQL with time_bucket_gapfill + locf over price_ticks joined to holding units.
- briefings(etf_id, day, script, audio bytea, mime), tilt_checks(id, owner_id, etf_id, at, pulse_bpm, breathing_bpm, baseline_pulse, verdict, raw jsonb).

## 7. Sponsor features
Core:
- Gemini Fund Architect: model gemini-3.5-flash via @google/genai with GEMINI_API_KEY. Do NOT use gemini-2.5-* (retiring mid-October 2026). Pipeline: (a) thesis → JSON {claims[], search_queries[], horizon_days, risk}; (b) candidates = pgvector top-k over question embeddings + Gamma public-search, filtered to active, liquid, resolving within the horizon, priced 0.05–0.95; (c) Gemini returns JSON {name, ticker, description, holdings:[{market_id, side, weight, rationale}]} under the section 3 constraints; validate with zod, retry once, then show the editable preview. Embeddings: the current Gemini embedding model (check the models list), 768 dimensions. Under 30 s end to end, with progress steps streamed to the UI.
- Tiger Data: section 6, the backtests, and query latencies displayed on /built-with.
Light (each behind a flag with a mock; build in this order):
1. ElevenLabs "Morning Bell": Gemini writes a ≤ 45-second script (today's NAV move, top movers, upcoming resolutions) → POST https://api.elevenlabs.io/v1/text-to-speech/{voice_id} with the xi-api-key header, model eleven_flash_v2_5 (fast) or eleven_v3 (expressive, ≤ 5,000 chars); check GET /v1/models. Cache one MP3 per ETF per day in the briefings table.
2. Solana (devnet): optional Phantom connect with sign-in by signed message, verified server-side (ed25519), linking the wallet to owner_id. "Publish", every rebalance and a daily close each write a memo transaction signed by a server attester keypair via @solana/kit + @solana-program/memo: PROPHETF|v1|{ticker}|{sha256(holdings)}|{nav}|{iso_ts}|{owner_wallet?}. If SOLANA_ATTESTER_SECRET_KEY is empty, generate a devnet keypair with a script, save it to .env.local, print only the public address, and tell me to fund it at faucet.solana.com. Store signatures, show Solana Explorer devnet links, and add a "Verify" button that re-hashes holdings from the DB and compares with the on-chain memo. Stretch: a Token-2022 mint per ETF as a share certificate sent to the owner's wallet.
3. Snowflake Cortex "Sector desk": POST https://<account_identifier>.snowflakecomputing.com/api/v2/cortex/inference:complete with Authorization: Bearer <PAT> and X-Snowflake-Authorization-Token-Type: PROGRAMMATIC_ACCESS_TOKEN. The response streams SSE, so parse the data: lines. Use it to (a) classify new markets into a fixed sector list (US Politics, World Politics, Macro & Rates, Crypto, AI & Tech, Business, Geopolitics, Science & Health, Culture, Sports) in batches of 25 with JSON output, written to markets.sector, and (b) write a ≤ 120-word daily fund letter per ETF. Pick a model available in my account's region; if none is, tell me to enable cross-region inference.
4. Presage "Tilt check": before saving a rebalance, an optional 20–30 s webcam check with explicit consent; never store the video; show "Not a medical device". First read Presage's current docs and tell me which path is simplest: (a) the SmartSpectra C++ SDK in a small Linux sidecar (Docker) that processes the uploaded clip, (b) Presage's video-upload Physiology API if it's still active, or (c) a phone companion via QR code. Build PRESAGE_MODE=mock first. Compare pulse with the user's first-check baseline: Calm, Elevated (> 15% above), Tilted (> 30% above). Elevated/Tilted prompts "cool down 5 minutes?". Log the result on the rebalance event; the factsheet shows calm vs tilted rebalance performance.
5. GoDaddy domain: I'll register it through the MLH GoDaddy Registry offer. Add it to the Vercel project and give me the exact DNS records to set at GoDaddy.

## 8. Phases (definition of done)
- Phase 0, Scaffold: Next.js app, lint/format, env loading, DB connection + migration runner, /api/health (DB + every flag), first Vercel deploy. Done: the Vercel URL shows health OK.
- Phase 1, Data core: schema, hypertables, continuous aggregates; sync-markets with v1/v2 IDs; the tick job; backfill from Data API v2; /markets with keyword search and sparklines. Done: ≥ 500 markets, prices landing every minute, /markets loads fast.
- Phase 2, ETF engine: ETF math with tests, manual builder, factsheet, NAV computation, resolution handling, leaderboard, and three seeded showcase ETFs with 30-day simulated history ($AIBULL "AI acceleration", $SOFTLND "Soft landing", $CHAOS "Geopolitical turbulence"). Done: I can create an ETF and watch its NAV move on the deployed site.
- Phase 3, AI Fund Architect: embeddings, semantic search on /markets, the Gemini pipeline, preview/edit, backtest toggle. Done: thesis → valid ETF in under 30 s.
- Phase 4, Light touches: section 7 items 1–4, in order.
- Phase 5, Ship: custom domain live, loading/empty/error states, mobile layout, /built-with, README (Mermaid architecture diagram, setup, per-sponsor notes), DEVPOST.md draft (Inspiration, What it does, How we built it, one "How we used X" paragraph per sponsor, Challenges, Accomplishments, What we learned, What's next) and docs/DEMO.md with a 2-minute demo script.

## 9. Environment variables
DATABASE_URL, GEMINI_API_KEY, SNOWFLAKE_ACCOUNT_URL, SNOWFLAKE_PAT, SNOWFLAKE_MODEL, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_MODEL_ID, SOLANA_RPC_URL=https://api.devnet.solana.com, SOLANA_ATTESTER_SECRET_KEY, NEXT_PUBLIC_SOLANA_CLUSTER=devnet, PRESAGE_API_KEY, PRESAGE_MODE=mock, PRESAGE_SIDECAR_URL, CRON_SECRET, APP_BASE_URL, FEATURE_SNOWFLAKE, FEATURE_ELEVENLABS, FEATURE_SOLANA, FEATURE_PRESAGE, FEATURE_WS. Polymarket needs no key.

Begin with section 0.

## Addendum (same message)
Existing repo: this repo already contains a teammate's static "MyETF mock portfolio simulator" (index.html, css/, js/, data/, scripts/, tests/), published on GitHub Pages. Do NOT delete or modify those files. First read README.md and the existing code, summarize what it does, and reuse its ideas, data and styling where useful. Build the new Next.js app inside a /web folder (all paths in this brief are relative to /web; Vercel Root Directory = web). Work on the prophetf-app branch and never push to main without asking me.
