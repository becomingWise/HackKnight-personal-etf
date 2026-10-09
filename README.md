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

## Layout

| Path | What |
| --- | --- |
| `backend/src/polyslice_api/data/universe.json` | Sectors, tickers, base weights; signals (search query, question match, βs) |
| `backend/src/polyslice_api/engine.py` | Pure weighting, suggestion and trade-ticket math (tested in `backend/tests`) |
| `backend/src/polyslice_api/polymarket.py` | Gamma search → live market per signal, CLOB price history, trending feed |
| `backend/src/polyslice_api/prices.py` | Last close via yfinance for the trade ticket |
| `backend/src/polyslice_api/main.py` | FastAPI routes: `/api/sectors`, `/api/signals`, `/api/signals/{id}/history`, `/api/feed`, `/api/basket`, `/api/ticket` |
| `frontend/src/components/` | Dashboard, scope picker, allocation donut, holdings table, signal cards with what-if sliders, trade ticket |

To add a signal, add an entry to `universe.json` and check it resolves at `/api/signals` (`status: "live"`). `match` must be a substring of the market question.

## Next up

- **Gemini**: prompt-to-basket (pick tickers + βs), map unmapped `/api/feed` markets to sectors, plain-English "why it rebalanced" notes.
- **Tiger Data (Postgres/Timescale)**: persist odds and weight snapshots for history charts and a backtest vs. static weights.
- **Backtest**: replay a past event with `prices-history` and compare dynamic vs. base basket returns.
