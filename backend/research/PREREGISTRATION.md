# Pre-registration: Polymarket spikes as a signal for the live rebalancer

Written 2026-10-09, before any of the tests below were run. Changes after this point go in the amendment log at the bottom, with the reason, and results are reported against the original plan.

## Data periods

| Period | Dates | Use |
| --- | --- | --- |
| Development | start of data → 2026-04-09 | All estimation, exploration and choosing configurations |
| **Holdout** | **2026-04-10 → 2026-10-09** | Evaluated **once**, at the end, with configurations frozen |

Code enforces this through `research.HOLDOUT_START`: research functions run on the development period unless explicitly called with `period="holdout"`. Walk-forward βs may *use* development data when scoring holdout events (that is how the live system would work); they never use holdout data to score holdout events from earlier dates.

Earlier work (event study, walk-forward βs, backtest sweeps) already looked at data through 2026-10-09, so the holdout is not pristine for those exact analyses. It is clean for H1–H3 below, which are new tests.

## Universe

S&P 500 constituents as of 2026-10-09, with GICS sector and sub-industry (`data/sp500.json`). **Survivorship caveat:** today's members include companies that grew into the index during the sample, which biases backtests upward. Point-in-time membership isn't freely available; the bias over a ~3-year window is noted, not corrected.

## Odds series and spikes (fixed)

The five chained series in `data/series.json`, sampled at 20:00 UTC. Daily spikes use `eventstudy.find_spikes` defaults: |z| ≥ 2.5 vs the prior 30 daily changes, |Δp| ≥ 3 pts, contract volume ≥ $1M, contract age ≥ 7 days, 3-day cooldown.

Hourly spikes (H1 only): an hourly odds change with |Δp| ≥ 3 pts and |z| ≥ 3 vs the prior 7 days of hourly changes, contract volume ≥ $1M, 6-hour cooldown, occurring 14:30–20:00 UTC on a US trading day.

## Exposures (βs)

Walk-forward, refit monthly on the prior 12 months, as in `betas.py`, extended to the full universe with **industry pooling**: each stock's β is shrunk toward its GICS sub-industry average, which is shrunk toward zero. Pooling weights come from the estimates' standard errors (empirical Bayes); no tuning on outcomes.

## Hypotheses

**H1 — Is there time to act? (intraday lead-lag)**
For hourly spikes, compute the exposure-weighted abnormal return (stock minus SPY, signed by sign(Δp) × sign(β)) of the 20 most-exposed stocks, hour by hour from −6h to +6h.
- H1a (window exists): cumulative abnormal return from +1h to +6h > 0.
- H1b (stocks lead): cumulative abnormal return from −6h to −1h > 0.
- Hourly stock data only reaches back ~730 days, so H1 covers roughly Oct 2024 onward.

**H2 — Is the exposure ranking real? (cross-sectional dose-response)**
On each daily spike date, regress all universe stocks' day-0 abnormal returns on their predicted move, β_i × Δp (Fama–MacBeth: one slope per date, then test the mean slope across dates).
- H2a: mean slope > 0.
- H2b: the top-minus-bottom quintile (by β_i × Δp) day-0 return spread > 0.
- H2c (volume dose-response): the slope is larger for spikes in contracts with above-median volume than below.

**H3 — Does the live mechanism help? (holdout only)**
Spike-triggered tilts using pooled walk-forward βs vs the same basket at static weights, for baskets of the 20 most-exposed universe stocks per series. Exactly three configurations, fixed now:

| Config | Look-back | z threshold | Hold days | Sensitivity |
| --- | --- | --- | --- | --- |
| A | 1 day | 2.5 | 5 | 2 |
| B | 1 day | 2.5 | 10 | 2 |
| C | 7 days | 2.5 | 10 | 2 |

Primary metric: max drawdown during spike windows (spike day through +10 days) vs static. Secondary: total return, Sharpe, turnover. All three reported, whichever wins.

## Decision rules

- Primary tests (H1a, H2a, H3 primary metric) need **t > 3** (Harvey–Liu–Zhu) to count as evidence; 2 < t < 3 is "suggestive".
- Every test also gets a placebo: the same spikes moved to random dates (500 runs), two-sided p-value.
- Stock-level lists ("which stocks are exposed") use Benjamini–Hochberg FDR at q = 0.10.
- Standard errors cluster by date. Number of tests run is reported with the results.

## Amendment log

**2026-10-09, after building the universe and running data-quality checks, before any H1–H3 test:**

1. *Partial survivorship fix.* The constituents table includes each stock's date added to the index. Research code ignores a stock before that date. This removes the bias from stocks that grew into the index, not from stocks that were removed.
2. *Return capping.* Daily stock returns are capped at ±20% in H2 regressions so a single event (e.g. MRNA +177% on 2026-08-19, unverified) can't drive a date's slope. H1 and H3 use uncapped returns.
3. *Stale prices.* Runs of 5+ consecutive zero-return days (e.g. SW's 2024 listing) are treated as missing.

**2026-10-09, after inspecting the first exposure fits (development data only), before any H1–H3 test:**

4. *Market-model abnormal returns.* "Stock minus SPY" made every low-beta stock look exposed to the recession series (269 FDR discoveries): recession odds rise on down-market days, and defensives simply fall less. Abnormal return is now stock − β_mkt × SPY, with β_mkt from the prior 252 trading days (no lookahead). This applies to exposures, H1, H2 and H3.
5. *Pooling estimator.* The first method-of-moments version left Taiwan βs at the ±1.5 cap with t ≈ 0 (heavy-tailed noise inflated the between-industry variance). τ² and ω² now use the DerSimonian–Laird estimator, the standard method-of-moments estimator for random effects.
6. *Return cap also applies to exposure estimation,* so estimates and tests use the same cleaned data.


**2026-10-10, implementing H1, before H1 was run on any real data.** Clarifications where the plan left details open; none changes a threshold:

7. *Hourly grid.* Odds are sampled at HH:30 UTC (last print at or before), the boundaries of US stocks' hourly bars, so each hourly odds change spans exactly one stock bar. Hourly series chain contracts exactly like the daily ones.
8. *"Occurring 14:30–20:00 UTC on a US trading day."* The whole hour of the change lies in that window (it ends 15:30–19:30 UTC) and SPY has a bar for that hour, which drops holidays and half-day afternoons. z uses the prior 168 hourly changes of the chained series (all hours, as the daily test uses all days), σ floored at 0.5 pt as in the daily test (this floor can't change a decision once |Δp| ≥ 3 pts). No contract-age filter, as written. Cooldown counts only between spikes.
9. *Hour axis.* −6h…+6h are trading bars relative to bar 0 (the spike's hour), so windows crossing the close include the overnight move in the next session's first bar. Bar returns are close-to-close; abnormal return uses that day's walk-forward β_mkt (amendment 4), uncapped (amendment 2), with the index-join filter (amendment 1). Cumulative abnormal return is the sum over bars.
10. *Most-exposed stocks.* The 20 largest |β| from the pooled walk-forward model as of the spike's date (stocks with |β| < 0.05 are excluded first, the model's default); weights are |β|.
11. *Inference.* Spikes on the same trading day are averaged into one score (date clustering), t-test across dates. Placebo: each spike keeps its series and direction and moves to a random in-session hour of the same series in the same period; 500 runs, seed 7, two-sided. Development period by default; the holdout run (`--holdout`) happens once, at the end, with H2–H3.

**2026-10-10, implementing H2, before H2 was run on any real data.** Clarifications; no threshold changes:

12. *Predicted move.* pred_i = β_i × Δp / 10 (app units back to return per unit of odds), so a slope of 1 means calibrated βs. β is the pooled walk-forward β usable on the spike date, for every stock where it's estimable (no |β| floor). Stocks without a β or a day-0 return drop out; a date needs ≥ 50 stocks.
13. *Dates.* A spike on a weekend or holiday counts on the next trading day, as in the event study. Spikes from several series on the same trading day add into one prediction, giving one slope per date.
14. *H2b.* The quintiles are the top and bottom 20% of stocks by pred on that date; the spread is computed per date, then t-tested across dates.
15. *H2c.* The median is taken over the contract volumes of the period's spikes. A date is "high" if all its spikes are above the median and "low" if all are at or below it; dates with both are excluded and counted. The test is the difference in mean slope (Welch t). Its placebo keeps each spike's volume label.
16. *Placebo.* Each spike keeps its series, Δp and volume label and moves to a random date of the same series in the same period; 500 runs, seed 7, two-sided on each test's statistic.

**2026-10-10, before H3 was built or run on any data.**

17. *Robustness rule: every result must survive dropping its largest event cluster.* Applies to every test, H1–H3 and any later one. Scored dates are sorted and grouped by single linkage: a date joins the previous date's cluster if it is within max(5, W) trading days, where W is the test's outcome window in trading days (H1 and H2: 5; H3: 10). The largest cluster is the one whose date scores sum furthest in the direction of the full-sample statistic. The test is rerun without that cluster (same t threshold, placebo not rerun). A result keeps its verdict only if the reduced t clears the same bar; otherwise it is reported at the lower verdict. A statistic that is ≤ 0 has nothing to lose. This rule was written after H1 turned out to lean on the April 2025 tariff week, so for H1 it is a stricter standard applied after the fact, not a test chosen in advance. For H2, which found nothing, it changes nothing. For H3 it is fixed before any run.
18. *H3 on development data first.* The plan ran H3 on the holdout only. It is now also built and run on the development period, as a pipeline check, with configurations A–C, the metric and the decision rule unchanged. Development results are reported, but they cannot change any of those; the holdout run is the test. Any change made after the development run is logged here with its reason.
19. *Trigger (the live mechanism, `backtest.spike_z`).* On the chained daily series (`history.as_history`, 20:00 UTC), z = look-back move / (σ of the 30 daily changes before the look-back, floored at 0.5 pt, × √look-back). |z| ≥ 2.5 at a close sets a tilt with Δp = the look-back move, held for `hold` trading days. A trigger while a tilt is active replaces Δp and restarts the hold, as in the backtest. `find_spikes`' 3 pt, volume, age and cooldown filters do not apply, because the live mechanism doesn't use them. Δp is used directly (the engine's clamp of reference odds to [0, 1] is skipped, because chained levels are synthetic).
20. *Baskets.* For each series and month: the 20 largest |β| from the pooled walk-forward model usable that month (|β| ≥ 0.05; the stock joined the index before the first of the month), equal base weights, rebuilt monthly. Both portfolios hold the same basket, and only the basket's own series tilts it: multiplier = clip(1 + 2 × β × Δp, 0, 3), renormalised (the `engine.reweight` formula). Days without a fitted basket, or outside the series' odds history, are not simulated.
21. *Returns and costs.* Daily adjusted close-to-close returns, uncapped (amendment 2), with stale runs missing (amendment 3); a missing return counts as 0 in both portfolios. Weights are set at close d from odds at 20:00 UTC on d and held to close d+1. Both portfolios pay 5 bp per unit of one-way turnover in target weights (so the static basket pays only when it is rebuilt).
22. *Primary metric.* An episode starts when a series triggers with no tilt active. Its window runs from the trigger-day close through +10 trading days (10 daily returns) of that series' basket. Score = max drawdown with tilts − max drawdown static, within the window (drawdowns are ≤ 0, so a positive score means a shallower drawdown). Episodes starting on the same trading day are averaged, then a t-test across dates. Episodes whose window crosses the period's end are dropped. Placebo: each episode moves as a block (its triggers keep their offsets and Δp) to a random eligible start day of the same series in the same period; 500 runs, seed 7, two-sided on the mean score.
23. *Secondary metrics* (descriptive, no tests). Per series basket over the period's simulated days, tilted vs static: total return, annualised Sharpe, max drawdown, average daily turnover; plus the average across series.
24. *Tests run:* 3 (the primary metric for configs A, B and C), each with a placebo and the cluster rule (amendment 17).
