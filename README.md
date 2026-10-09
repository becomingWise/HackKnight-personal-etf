# PolySlice

Thematic stock baskets that rebalance on live Polymarket odds. Pick a scope (one or more sectors); PolySlice tilts the weights inside it as prediction-market probabilities move, and flags sectors outside your scope that the feed is moving hard. HackKnight 2026.

Simulation only: no brokerage, no orders, not investment advice.

## Run it

Two terminals, from the repo root:

```sh
uv run --directory backend uvicorn polyslice_api.main:app --reload --port 8000
```

```sh
cd frontend && npm install && npm run dev
```

Open http://localhost:3000. The frontend proxies `/api/*` to the backend (override with `API_URL`). Needs [uv](https://docs.astral.sh/uv/) and Node 20+.

Backend tests: `uv run --directory backend pytest`.

## How the weighting works

Each sector has fixed base weights. Each **signal** is a live Polymarket market with a sensitivity β per ticker (positive = the stock benefits if the event gets more likely). For holding *i*:

```
multiplier_i = clip(1 + k · Σ_s β_is · (P_s − P_ref_s), 0, 3)
weight_i     = base_i · multiplier_i / Σ_j base_j · multiplier_j
```

`P_s` is the current odds (or a what-if value from the slider), `P_ref_s` the odds at the start of the look-back window (24h / 7d / 30d, from Polymarket's price-change fields), and `k` the sensitivity setting.

**Scope suggestions** score every sector outside the scope by the average |multiplier − 1| its holdings would get from current moves, and surface the top ones with the market driving them.

## Backtest

`POST /api/backtest` with `{"scope": ["semis"], "days": 180, "lookback_days": 7, "sensitivity": 2, "cost_bps": 5}` replays each trading day. Weights are set at the close using only the last Polymarket print at or before it, then held to the next close. The static benchmark is the same basket rebalanced daily to base weights, so the only difference is the Polymarket tilt. Returns both value curves, daily weights, stats (return, volatility, Sharpe, max drawdown, turnover) and the biggest rebalancing days.

Two modes (`"mode"`):

- `continuous` (default): every odds move over the look-back tilts the basket.
- `spike`: only unusually large moves count. A move is a spike when it exceeds `z_threshold` (default 2) standard deviations of that market's daily changes over the prior 30 days. The tilt is held for `hold_days` (default 10), then the basket reverts to base weights. Turnover drops from about 2.6% to under 1% a day.

The response also lists every spike and repeats the stats for each half of the period (`stats.halves`). A setting that only works in one half is probably fitting noise.

**Findings so far (last ~125 trading days):** neither mode reliably beats static weights. No spike setting was positive in both halves for more than 2 of 5 baskets. Treat the tilt as risk management, not a return edge, until the event study says otherwise.

Caveat: the βs were chosen today, so any backtest carries hindsight bias.

## Long odds history

Live markets only go back a few months, so `history.py` chains resolved and live contracts into continuous series, the way futures are rolled. Each day uses the nearest contract with enough time left. Moves are only measured within one contract, so a roll never registers as a spike. Series are defined in `data/series.json`:

| Series | Contracts | Since |
| --- | --- | --- |
| Fed cuts at the next meeting | 29 FOMC meetings | Mar 2023 |
| China invades Taiwan | 9 | Oct 2023 |
| Russia-Ukraine ceasefire | 42 | Sep 2024 |
| US recession | 3 | Jan 2025 |
| Trump wins 2024 | 1 | Jan 2024 |

Build or refresh the cache (`backend/.cache/series/`, about 6 seconds):

```sh
uv run --directory backend python -m polyslice_api.history
```

Odds are sampled from hourly data at the US close (20:00 UTC), so each day's odds change covers the same span as that day's close-to-close stock return. The Ukraine series mixes "ceasefire" and "ceasefire agreement" questions.

## Event study

Do Polymarket spikes predict the stocks they should move?

```sh
uv run --directory backend python -m polyslice_api.eventstudy
```

Spikes are daily odds changes of at least 2.5σ (vs. the prior 30 days) and 3 points, from contracts with $1M+ volume that are at least 7 days old, with a 3-day cooldown. For each spike, every stock with a β gets a market-adjusted return (stock minus SPY), signed so that positive means it moved the way the β predicted, and weighted by |β|. Scores are averaged per date and tested with a t-test, a binomial hit rate, and a placebo that moves the same spikes to 500 random dates.

The same spikes are scored under three sets of βs. "Data" and "blend" βs are refit monthly from the prior 12 months only (`betas.py`), so they never see the future: data = estimates alone, blend = estimates shrunk toward the hand-picked guesses by confidence.

**Results (61 spikes on 58 dates, 2023–2026).** Mean is the |β|-weighted return vs. SPY, positive = the predicted direction; p is the random-date placebo.

| Window | Hand βs | Data βs (walk-forward) | Blend βs (walk-forward) |
| --- | --- | --- | --- |
| 5 days before | +51 bp (t 1.5, p 0.22) | +22 bp (t 0.6, p 0.65) | +36 bp (t 1.2, p 0.33) |
| **Spike day** | +27 bp (t 1.4, p 0.13) | **+59 bp (t 2.6, p 0.002)** | **+37 bp (t 2.4, p 0.01)** |
| Next day | +54 bp (t 2.9, p 0.002) | −16 bp (t −0.8, p 0.40) | +20 bp (t 1.3, p 0.20) |
| Next 5 days | +81 bp (t 2.1, p 0.05) | +10 bp (t 0.2, p 0.81) | +35 bp (t 1.1, p 0.34) |

What holds up:

- **Same-day reaction is real.** With βs estimated only from past data, stocks move in the predicted direction on the spike day 69% of the time, and random dates almost never match it. Polymarket spikes are a valid real-time read on event risk.
- **Next-day predictability doesn't survive.** It only shows up with the hand-picked βs and disappears with walk-forward ones, so it is likely hindsight in how the βs were chosen. Don't claim alpha.
- **Ukraine ceasefire → defense** is the one topic where the next-5-day drift holds under all three (t 3.7 / 1.7 / 3.1), but it's 12–16 dates mostly from 2025 peace-talk news.

Caveats: small sample, several windows tested, and market adjustment makes anything less risky than SPY look like it "rose" on bad news.

## Layout

| Path | What |
| --- | --- |
| `backend/src/polyslice_api/data/universe.json` | Sectors, tickers, base weights; signals (search query, question match, βs) |
| `backend/src/polyslice_api/engine.py` | Pure weighting, suggestion and trade-ticket math (tested in `backend/tests`) |
| `backend/src/polyslice_api/polymarket.py` | Gamma search → live market per signal, CLOB price history, trending feed |
| `backend/src/polyslice_api/backtest.py` | Daily replay of the dynamic basket vs. the same basket at base weights; continuous and spike modes (tested in `backend/tests`) |
| `backend/src/polyslice_api/history.py`, `data/series.json` | Long odds series chained from resolved + live contracts (tested in `backend/tests`) |
| `backend/src/polyslice_api/eventstudy.py` | Spike detection, signed abnormal returns, placebo test, empirical βs (tested in `backend/tests`) |
| `backend/src/polyslice_api/betas.py` | Walk-forward βs: monthly regressions on the prior 12 months, capped and shrunk toward the guesses (tested in `backend/tests`) |
| `backend/src/polyslice_api/prices.py` | Last close and daily history via yfinance |
| `backend/src/polyslice_api/main.py` | FastAPI routes: `/api/sectors`, `/api/signals`, `/api/signals/{id}/history`, `/api/feed`, `/api/basket`, `/api/ticket`, `/api/backtest` |
| `frontend/src/components/` | Dashboard, scope picker, allocation donut, holdings table, signal cards with what-if sliders, trade ticket |

To add a signal, add an entry to `universe.json` and check it resolves at `/api/signals` (`status: "live"`). `match` must be a substring of the market question.

## Next up

- **Gemini**: prompt-to-basket (pick tickers + βs), map unmapped `/api/feed` markets to sectors, plain-English "why it rebalanced" notes.
- **Tiger Data (Postgres/Timescale)**: persist odds and weight snapshots for history charts and faster backtests.
- **Use walk-forward βs in the live app** (the event study prints the current blended ones), and frame the product around real-time event-risk detection rather than alpha.
- **Backtest chart** in the frontend for `/api/backtest`.
