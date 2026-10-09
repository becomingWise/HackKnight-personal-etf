# Methodology and results log

How PolySlice tests whether Polymarket odds are a usable signal for rebalancing, and everything found so far, including null results. The forward-looking plan, its fixed thresholds and the amendment history are in [PREREGISTRATION.md](PREREGISTRATION.md).

## Question

When a prediction market's odds move sharply, do the stocks exposed to that event move in the expected direction, and is there time for a live rebalancer to act on it?

## Data

| Source | What | Code |
| --- | --- | --- |
| Polymarket Gamma API | Market discovery: live and resolved events, questions, volumes | `polymarket.py`, `history.py` |
| Polymarket CLOB API | Price history per outcome token: daily (`interval=max`) and hourly (≤14-day windows) | `history.py` |
| Wikipedia, S&P 500 list | 503 constituents with GICS sector, sub-industry and index-join date (as of 2026-10-09) | `universe.py` |
| Yahoo Finance (`yfinance`) | Daily adjusted closes, Jan 2023 → today, for 513 instruments + SPY | `universe.py`, `prices.py` |

**Long odds series.** Live markets only go back months, so expiring contracts are chained like rolled futures: each day uses the nearest contract with enough time left, and changes are only measured within a contract (a roll is never a move). Five series: Fed cut at the next meeting (29 contracts, from Mar 2023), China invades Taiwan (9, from Oct 2023), Russia–Ukraine ceasefire (42, from Sep 2024), US recession (3, from Jan 2025), Trump wins 2024 (1).

**Timing.** Odds are sampled from hourly prints at **20:00 UTC** (the US close), so a day's odds change spans the same window as that day's close-to-close stock return. Weekend and holiday moves roll into the next trading day. An earlier version used twice-daily prints (00:00/12:00 UTC); that shifted every odds move a day late and produced a fake "bonds lead Fed odds by one day" pattern, which disappeared once fixed.

**Cleaning** (pre-registered amendments 1–3): stocks are ignored before their index-join date (partial survivorship fix); runs of 5+ zero-return days are missing; daily returns are capped at ±20% in estimation and cross-sectional tests.

**Abnormal return** (amendment 4): stock − β_mkt × SPY, with β_mkt from the prior 252 trading days. Plain "stock − SPY" made every low-beta stock look exposed to recession odds.

## Spikes

A daily odds change is a spike when |Δp| ≥ 3 pts and |z| ≥ 2.5, where z scales Δp by the standard deviation of the prior 30 daily changes (floored at 0.5 pt). Contracts must have ≥ $1M lifetime volume and be ≥ 7 days old (thin and new contracts fake spikes); a 3-day cooldown keeps one story from counting repeatedly. 61 spikes on 58 dates, 2023–2026. (`eventstudy.find_spikes`)

## Exposures (βs)

β = how much a stock moves vs. expectation per odds move, in app units (10 × slope; 1.0 = 10% per 100-pt move), capped at ±1.5. Three generations:

1. **Hand-picked** (`data/universe.json`, `data/series.json`): economic guesses for ~40 tickers. Several signs turned out wrong against data.
2. **Walk-forward, per stock** (`betas.py`): monthly regressions on the prior 12 months, shrunk toward the guess by confidence.
3. **Universe-wide, industry-pooled** (`exposures.py`): every S&P 500 stock, monthly walk-forward regressions, then empirical-Bayes shrinkage toward the GICS sub-industry mean, and of the industry mean toward zero (DerSimonian–Laird variance estimates). Stock-level "is this stock exposed?" claims use Benjamini–Hochberg FDR at q = 0.10.

Walk-forward means a β used on date d is fit only on data before the first of d's month.

## Tests

- **Event study** (`eventstudy.py`): for each spike, exposure-weighted abnormal return in windows around it, signed so positive = moved as predicted. One score per date (same-day events can't double count), t-test across dates, binomial hit rate, and a placebo that moves the same spikes to 500 random dates.
- **Backtest** (`backtest.py`): daily replay of tilted vs. static weights using only odds known at each close, 5 bp per unit turnover, stats per half-period. Continuous and spike-triggered modes.
- **Pre-registered H1–H3** (intraday lead-lag, cross-sectional dose-response, live mechanism on the holdout): see the plan.

## Results log

Newest first. "Tests run" counts distinct statistical tests behind each claim, for multiple-testing context.

**2026-10-09: Universe-wide exposures (development data, fit as of 2026-04-01).** Stocks with raw |t| > 2 vs. ~22 expected by chance among 489:
- Fed cut odds: 44; 6 FDR discoveries: homebuilders (DHI, LEN), IEF, SHY, ALGN, RMD. Economically sensible (rate-sensitive).
- Recession odds: 103; 21 discoveries. Includes crypto and PLTR rising with recession odds, which is unexplained, so treat it as suspect.
- Taiwan: 31; none. Oil & gas producers lean positive as an industry, but the evidence is weak.
- Ukraine ceasefire: 22, the chance level. No daily exposure found.
- Tests run: 4 series × 489 stocks, FDR-controlled.

**2026-10-09: Event study with three β generations (all data, before the holdout was set).** 61 spikes, 58 dates. Return vs. market in the predicted direction:

| Window | Hand βs | Walk-forward (data) | Walk-forward (blend) |
| --- | --- | --- | --- |
| Spike day | +27 bp (t 1.4, placebo p 0.13) | **+59 bp (t 2.6, p 0.002)** | **+37 bp (t 2.4, p 0.01)** |
| Next day | +54 bp (t 2.9, p 0.002) | −16 bp (t −0.8, p 0.40) | +20 bp (t 1.3, p 0.20) |
| Next 5 days | +81 bp (t 2.1, p 0.05) | +10 bp (t 0.2, p 0.81) | +35 bp (t 1.1, p 0.34) |

- **Same-day reaction holds out of sample** (suggestive by the t > 3 bar).
- **Next-day "predictability" was hindsight.** It appears only with hand-picked βs.
- Ukraine → defense next-5-day drift held under all three (t 3.7 / 1.7 / 3.1) on 12–16 dates, but the daily regressions above find no Ukraine exposure. Unresolved.
- Tests run: 5 windows × 3 β sets, plus per-series breakdowns.

**2026-10-09: Spike-mode backtest sweep (last ~125 trading days).** 16 configurations × 5 baskets. Turnover fell from ~2.6% to 0.1–0.9% a day, but no configuration beat static weights in both halves for more than 2 of 5 baskets. The +49.7% crypto result came from one Bitcoin spike in one half. Conclusion: no robust return edge. This sweep is why H3 is limited to three pre-set configurations.

**2026-10-09: Continuous-tilt backtest (180 days).** Within ±0.7% of static at default settings across 7 baskets. Lower drawdown in some settings did not reliably mean a higher ending balance.

## Known limitations

- Small samples: tens of spike dates, a few years of history, 5 series.
- Survivorship bias only partly corrected (no removed stocks).
- Earlier analyses saw data through 2026-10-09; the holdout is clean only for H1–H3.
- Prediction-market odds are event probabilities, not return forecasts.
- Chained series mix contract horizons; the Ukraine series mixes "ceasefire" and "ceasefire agreement" questions.
