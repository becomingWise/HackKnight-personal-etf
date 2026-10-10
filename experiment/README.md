# Basket Lab experiment

Local prototype on `codex/shaun-experiment`, based on `lucas-branch` at `6cb4ca0`.
No deployment or remote push. No Tiger writes. The original root application and deployed endpoints
keep their three-stock default; this separate local server explicitly requests a 7–10-company shortlist.

```sh
npm run experiment
# Open http://127.0.0.1:8790
```

The default **Example shortlist** ranks the existing company list by sector keywords. It is explicitly
labelled and never substitutes for a failed Gemini call. For actual **Gemini suggestions**, set
`GEMINI_API_KEY` in this checkout's ignored `agent/.env` (see `agent/.env.example`) and restart.
Suggestions use only Flash-Lite models, local memory/cache, and no shared database. API keys are never
sent to the browser. Nothing is added to the user's basket automatically. Existing basket selections
are retained when searching for another idea.

The basket uses equal weights by default. Users can import JSON records with `symbol`,
`floatAdjustedMarketCap`, `currency: "USD"`, `asOf`, and `source` (HTTP(S) URL), and choose market-cap
weights when **every selected holding** has valid data. All observations must be recent (30 days) and
from the same date (one-day maximum spread). `capitalization.example.json` contains deliberately blank
fields; this prototype does not invent market capitalizations. The S&P formula is float-adjusted value
divided by total float-adjusted value; here that total covers only the selected holdings.
Reference: https://www.spglobal.com/spdji/en/documents/methodologies/methodology-index-math.pdf

## Historical event scenarios

The committed `data/snapshot.json` contains real observed public data, fetched on 2026-10-10:
34 allowed companies and SPY (a year of adjusted daily closes from Yahoo Finance), and the 11 configured
open events with Polymarket Data API v2 price histories. Source URLs and observation timestamps are
stored with the records. **Refresh observations** only reads public APIs and writes an ignored local
cache (`experiment/.cache`); the committed snapshot remains available if upstream services fail.
CLI: `npm run experiment:refresh`; `node experiment/refresh.mjs --snapshot` updates the committed file.

The team's existing hand-set exposure map chooses which events are *plausibly connected* to a company.
Its hand-set betas are **not used for numerical scenario effects**. Each effect is estimated from the
selected company's own observed price data and that exact event's history (no mixing expiration
contracts). Current v2 and legacy Yes-token IDs may refer to the same market; the legacy ID supplies
history when the migrated ID is empty. Outcome order is resolved by the actual `Yes` label.

- Align adjusted stock closes and odds snapshots at the US close, including daylight saving time.
  Odds are 12-hour buckets; use the last snapshot at/before the close, no older than 18 hours. Weekend
  moves enter the next trading day. Missing snapshots break pairs. Exclude incomplete current-day
  prices and observations with stock/SPY returns beyond ±20%.
- Fit `stock daily return = intercept + slope × daily odds change + marketBeta × SPY daily return`.
  At least 60 varying, overlapping daily changes are required. Uncertainty uses Newey–West lag-5
  standard errors, an approximate normal 95% interval and approximate normal p values.
- Show **partial R²** as historical strength: the share of market-adjusted return variation associated
  with odds changes. This is not a causal score or probability that an event affects the stock.
- Apply Benjamini–Hochberg q values across the available, configured events for that stock. Split
  chronologically 80/20, fit each sample separately, and report whether directions agree. Require
  120+ days, q≤0.10, a mean interval excluding zero and consistent direction before displaying
  "Observed association"; otherwise show "Weak evidence". This is exploratory screening, not a
  validation of the original team's holdout hypotheses or a proven trading signal.
- Slider estimate: `100 × slope × (target odds − observed odds)`, a percent **same-day return relative
  to SPY holding SPY fixed**, not a future price or expected return. Its interval describes uncertainty
  in the fitted mean association; it is not a predictive interval for an individual stock return.
  Moves larger than the largest measured daily odds change show an extrapolation warning.
- Scenarios never change allocations. Effects across different events must not be added together.
  Insufficient history means no numerical slider, rather than a fabricated beta or zero effect.

Important limits: temporal precision is restricted by the 12-hour odds snapshots; selection of only
currently open markets introduces selection bias; other contemporaneous events and omitted factors
can drive both series; rolling holiday gaps and stale trading are imperfectly handled; a finite
single-market history can be unstable. The original research (`backend/research/METHODOLOGY.md`)
found **no confirmed primary H1–H3 signal in its holdout**. This UI displays relationships for exploration,
not forecasts, causal effects or a trading recommendation.

## Verification

`node --test tests/*.test.js` runs the original contract tests plus experimental tests for count
bounds, optional selection, allocation rounding/capitalization validation, close alignment, known-slope
regression, missing history, uncertainty, unchanged allocation, v1/v2 token history, and local HTTP.
The UI is checked at desktop and mobile sizes. The shared agent copies in `web/src/lib/agent-core`
are synchronized by the existing sync script; the Next.js routes keep their original three-stock
default. Nothing is deployed. The existing local key was rejected by Google as invalid during the
live test; use a valid key to try Gemini. The numerical histories and example mode are usable without it.
