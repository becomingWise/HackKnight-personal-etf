# Basket Lab: three-page experiment

Local prototype on `codex/shaun-experiment`, based on Lucas's branch. No remote push,
deployment, trading, or writes to the team's database. The original application retains
its three-stock contract; this experiment requests 7–10 companies.

```sh
npm run experiment
# http://127.0.0.1:8790/
```

## Journey

- `/`: one idea box with an integrated submit button. Suggestions run only on submission.
- `/basket`: all suggested companies enter the paper basket automatically. Delete and undo
  update equal allocations, which sum to 100% after display rounding. Export contains the
  retained holdings. No weighting selector, cap import, or S&P explanation remains.
- `/events`: basket simulation, selected-stock performance, Polymarket and Kalshi filters,
  event odds history, and an illustrative future scenario.

Browser session storage preserves the idea, candidates, deletions and undo stack through
navigation and refresh. A successful new idea replaces the basket; failed suggestions keep
it intact. Visits to protected pages without retained holdings return to `/`. Empty baskets
cannot continue; undo remains available on the current basket page.

Example suggestions are the default and are labelled on page two. They rank the allowed
company list by sector keywords; the price and event histories are genuine observations.
For live suggestions set `EXPERIMENT_SUGGESTION_MODE=gemini` and a valid `GEMINI_API_KEY` in
this checkout's ignored `agent/.env`, then restart. Only Flash-Lite models are used, with
local memory/cache. An invalid key produces an error, never an example fallback. The
previously supplied key was rejected by Google during the earlier live test.

## Public data and interfaces

The committed schema-v2 snapshot includes adjusted daily prices for 34 companies and SPY,
11 Polymarket contracts, and seven verified Kalshi topic-series contracts, fetched on
2026-10-10. `/api/analysis` accepts `{ "symbols": ["NVDA", "TSM"] }` by POST, validates
1–10 unique allowed companies, and returns allocations, indexed shared-date histories,
provider-qualified events, raw odds histories, and independently fitted basket/stock
relationships. `/api/stocks` accepts an idea and uses the server's configured mode when
no explicit mode is supplied. Existing experimental endpoints remain available.

`npm run experiment:refresh` refreshes the ignored cache. `node experiment/refresh.mjs
--snapshot` updates committed observations. The newest valid snapshot wins; old schema-v1
Polymarket snapshots are migrated in memory. Failed refreshes retain previous unexpired
observations with stale labels. Each upstream provider fails independently. Kalshi reads
are paced and rate-limit retries are bounded. Partial history errors remain visible.

Kalshi series are curated for OpenAI IPO timing, AI safety audits, no Fed cuts, recession,
Hormuz traffic, an Iran nuclear agreement and Bitcoin reaching $100k. These are business-topic
links, not claims that provider contracts have equivalent settlement rules. The most traded
eligible open binary contract in each configured series is used; year predicates apply to
rates and recession. Titles, deadlines, contract IDs, settlement rules and source links are
kept. No histories are joined across providers, outcomes or expirations. No verified Kalshi
match is claimed for the remaining four business topics.

Kalshi historical and current odds are Yes bid/ask midpoints, parsed from fixed-point dollar
fields. Both valid quotes are required; missing/crossed quotes, synthetic previous prices
and unfinished candles are not invented. Polymarket keeps its observed Yes outcome prices
and exact v2/legacy token history selection. Observation and source timestamps are stored.

References: https://docs.kalshi.com/getting_started/quick_start_market_data,
https://docs.kalshi.com/api-reference/market/get-market-candlesticks,
https://data-api.polymarket.com/v2/docs

## Charts and scenarios

Basket history replays today's retained stocks, rebalancing equally at each shared observed
daily close. It compounds the average daily adjusted return and starts at index 100. Stock
charts use the same dates and initial index; individual fits use each stock's own available
observations independently of missing dates in other holdings. Missing observations are not filled. This
is a simulation of today's composition, not an actual historical ETF. A missing company
history prevents a complete basket simulation rather than silently dropping that company.
Charts show 1M/3M/1Y windows (3M default); the initial full-period indexing stays fixed.
SVG tooltips support pointer input and keyboard arrows/Home/End.

Fit `daily return ~ intercept + daily odds change + SPY daily return`. The basket is fitted
directly, not assembled from hand-set stock betas. Business links select eligible stock-event
pairs; their hand-set betas never set numerical effects. At least 60 varying paired changes
are required. Odds must precede the DST-aware US close, including scheduled 1pm early closes, and be no
more than 18 hours old.
Missing observations break pairs; weekend moves roll into the next session. Incomplete
today prices and returns beyond ±20% are excluded. Partial R², Newey–West lag-5 standard
errors, approximate normal p values, an 80/20 chronological direction check and per-target
Benjamini–Hochberg correction qualify evidence. Weak evidence stays visible.

A slider creates a linear odds ramp over the next 20 scheduled US exchange sessions.
The path is `last historical index × (1 + slope × cumulative odds change)`. Its endpoint
applies the shock once, not twenty times. Broader-market movement and other events are
held fixed. A shaded 95% band describes slope-estimation uncertainty, NOT future-return
uncertainty. Unsupported fits or nonpositive index ranges suppress the future illustration.
Changing events resets odds; changing the stock preserves that event's current scenario.
No unlinked stock effect is assumed. No scenario changes holdings or weights, and different
event effects cannot be added together.

Session dates exclude weekends, standard NYSE holidays and Good Friday; early-close days
count as sessions. The [NYSE calendar](https://www.nyse.com/trade/hours-calendars)
defines the schedule. Unexpected exchange closures cannot be anticipated. Future paths are
explicitly illustrative: the team's original holdout research did not confirm a reliable
forecasting signal. Temporal sampling, open-market selection and omitted causes restrict
interpretation of these fitted relationships.

## Verification

Run `node --test tests/*.test.js`. Checks cover the original contracts, automatic population,
deletion/undo/storage, equal allocations, shared-date basket replay, provider normalization,
missing/future quotes, contract separation, outage retention, analysis validation, suggestion
failures, exchange-calendar dates, cumulative scenario paths and uncertainty. Browser checks
cover all three pages, direct visits, refresh recovery, desktop/mobile layouts, chart tooltips,
provider filtering and sliders changing both charts while leaving weights fixed.
