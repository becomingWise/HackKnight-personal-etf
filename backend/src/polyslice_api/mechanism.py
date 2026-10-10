"""H3: does the live mechanism help? Spike-triggered tilts vs the same basket at static weights.

Pre-registered in research/PREREGISTRATION.md (H3, amendments 17–24). For each
odds series, a basket of the 20 stocks most exposed to it (pooled walk-forward
βs, rebuilt monthly, equal base weights) is replayed daily twice: at static
weights, and tilted by the live app's spike trigger (`backtest.spike_z`):

    multiplier_i = clip(1 + k · β_i · Δp, 0, 3)     while a tilt is active

A trigger (|z| ≥ threshold at a close) sets Δp to the look-back move and holds it
`hold` trading days; a new trigger while active replaces Δp and restarts the hold.

Primary metric: for each episode (a trigger with no tilt active), max drawdown
over the trigger-day close through +10 trading days, tilted minus static
(positive = shallower drawdown). Episodes on the same day are averaged; t-test
across dates; t > 3 counts as evidence. Placebo: episodes moved as blocks to
random start days of the same series (500 runs). Every result must also survive
dropping its largest event cluster (amendment 17).

Run `uv run python -m polyslice_api.mechanism` (development period).
`--holdout` runs the holdout and is used once, at the end.
"""

from __future__ import annotations

import math
import random
import sys
from dataclasses import dataclass
from datetime import date
from typing import Any

import numpy as np
import pandas as pd

from . import backtest, research
from .engine import MAX_MULTIPLIER

TOP_N = 20
MIN_ABS_BETA = 0.05
WINDOW = 10
COST_BPS = 5.0
VOL_WINDOW = 30


@dataclass(frozen=True)
class Config:
    name: str
    lookback: int
    z: float
    hold: int
    sensitivity: float


CONFIGS = [Config("A", 1, 2.5, 5, 2.0), Config("B", 1, 2.5, 10, 2.0), Config("C", 7, 2.5, 10, 2.0)]


@dataclass
class Basket:
    """One series' basket on the trading calendar: day t holds `cols[t]` with βs `betas[t]`."""
    series: str
    cols: np.ndarray    # T × TOP_N column indices into the return matrix (−1 = no basket that day)
    betas: np.ndarray   # T × TOP_N pooled β (app units)
    active: np.ndarray  # T bool: basket exists and the series has odds that day


def triggers(history: list[dict[str, float]], calendar: list[date], cfg: Config) -> list[tuple[int, float]]:
    """(day index, Δp) for every close where the live trigger fires."""
    out = []
    for i, d in enumerate(calendar):
        now = backtest.close_ts(d)
        z = backtest.spike_z(history, now, cfg.lookback, VOL_WINDOW)
        if z is not None and abs(z) >= cfg.z:
            p_now = backtest.odds_at(history, now)
            p_ref = backtest.odds_at(history, now - cfg.lookback * backtest.DAY)
            out.append((i, p_now - p_ref))
    return out


def tilt_path(firings: list[tuple[int, float]], hold: int, days: int) -> np.ndarray:
    """Δp in force on each day (0 = no tilt): a later trigger replaces Δp and restarts the hold."""
    delta = np.zeros(days)
    for i, dp in sorted(firings):
        delta[i:i + hold] = dp
    return delta


def episodes(firings: list[tuple[int, float]], hold: int) -> list[list[tuple[int, float]]]:
    """Group triggers into episodes: a trigger starts one when no tilt is active."""
    out: list[list[tuple[int, float]]] = []
    until = -1
    for i, dp in sorted(firings):
        if i >= until:
            out.append([])
        out[-1].append((i, dp))
        until = i + hold
    return out


def weights(betas: np.ndarray, delta: np.ndarray, sensitivity: float) -> np.ndarray:
    """T × N target weights from equal base weights (`engine.reweight`, vectorised)."""
    mult = np.clip(1.0 + sensitivity * betas * delta[:, None], 0.0, MAX_MULTIPLIER)
    total = mult.sum(1, keepdims=True)
    base = np.full_like(mult, 1.0 / mult.shape[1])
    return np.where(total > 0, mult / np.where(total > 0, total, 1.0), base)


def turnover(w: np.ndarray, cols: np.ndarray) -> np.ndarray:
    """One-way turnover in target weights per day, matching holdings by stock across rebuilds."""
    out = np.zeros(len(w))
    for t in range(1, len(w)):
        prev = dict(zip(cols[t - 1], w[t - 1])) if cols[t - 1, 0] >= 0 else {}
        now = dict(zip(cols[t], w[t])) if cols[t, 0] >= 0 else {}
        if prev and now:
            out[t] = sum(abs(now.get(k, 0.0) - prev.get(k, 0.0)) for k in prev.keys() | now.keys()) / 2
    return out


class Replay:
    """Precomputed per-series returns, so each run only redoes the tilted leg."""

    def __init__(self, basket: Basket, next_returns: np.ndarray, cost_bps: float = COST_BPS):
        self.basket = basket
        self.R = np.nan_to_num(np.take_along_axis(next_returns, np.maximum(basket.cols, 0), axis=1))
        self.cost = cost_bps / 10_000
        static_w = np.full(basket.betas.shape, 1.0 / basket.betas.shape[1])
        self.static_turnover = turnover(static_w, basket.cols)
        self.static = (static_w * self.R).sum(1) - self.cost * self.static_turnover

    def dynamic(self, delta: np.ndarray, sensitivity: float) -> tuple[np.ndarray, np.ndarray]:
        w = weights(self.basket.betas, delta, sensitivity)
        tv = turnover(w, self.basket.cols) if delta.any() else self.static_turnover
        return (w * self.R).sum(1) - self.cost * tv, tv


def max_drawdown(returns: np.ndarray) -> float:
    curve = np.concatenate([[1.0], np.cumprod(1 + returns)])
    return float((curve / np.maximum.accumulate(curve) - 1).min())


def episode_scores(eps: list[list[tuple[int, float]]], dyn: np.ndarray, static: np.ndarray,
                   eligible: np.ndarray) -> list[tuple[int, float]]:
    """(start day, drawdown difference) for each episode whose whole window is eligible."""
    out = []
    for ep in eps:
        i = ep[0][0]
        if i + WINDOW <= len(eligible) and eligible[i:i + WINDOW].all():
            out.append((i, max_drawdown(dyn[i:i + WINDOW]) - max_drawdown(static[i:i + WINDOW])))
    return out


def by_date(scores: list[tuple[int, float]], calendar: list[date]) -> dict[date, float]:
    groups: dict[int, list[float]] = {}
    for i, v in scores:
        groups.setdefault(i, []).append(v)
    return {calendar[i]: sum(v) / len(v) for i, v in sorted(groups.items())}


def run_config(cfg: Config, replays: dict[str, Replay], firings: dict[str, list[tuple[int, float]]],
               eligible: dict[str, np.ndarray], calendar: list[date], *, placebo: int = 500, seed: int = 7) -> dict[str, Any]:
    days = len(calendar)
    scores: list[tuple[int, float]] = []
    secondary = {}
    real_eps = {}
    for sid, rp in replays.items():
        delta = tilt_path(firings[sid], cfg.hold, days)
        dyn, tv = rp.dynamic(delta, cfg.sensitivity)
        eps = [ep for ep in episodes(firings[sid], cfg.hold) if eligible[sid][ep[0][0]]]
        real_eps[sid] = eps
        scores += episode_scores(eps, dyn, rp.static, eligible[sid])
        m = eligible[sid]
        if m.any():
            secondary[sid] = {"dynamic": summary_stats(dyn[m]), "static": summary_stats(rp.static[m]),
                              "turnover_dynamic": float(tv[m].mean()), "turnover_static": float(rp.static_turnover[m].mean()),
                              "days": int(m.sum()), "episodes": len(eps)}

    dated = by_date(scores, calendar)
    xs = list(dated.values())
    mean = sum(xs) / len(xs) if xs else math.nan
    t = research.t_stat(xs)
    robust = research.drop_largest_cluster(dated, calendar, WINDOW) if xs else None
    full, kept = research.robust_verdict(t, robust["t"]) if robust else ("not supported", "not supported")
    result = {"config": cfg.__dict__, "episodes": len(scores), "dates": len(xs), "mean_bp": mean * 10_000, "t": t,
              "shallower": sum(x > 0 for x in xs) / len(xs) if xs else math.nan,
              "verdict": full, "robust": robust, "robust_verdict": kept, "secondary": secondary, "rows": dated}

    if placebo and xs:
        rng = random.Random(seed)
        starts = {sid: np.flatnonzero([eligible[sid][i:i + WINDOW].all() and i + WINDOW <= days
                                       for i in range(days)]) for sid in replays}
        null = []
        for _ in range(placebo):
            fake_scores = []
            for sid, rp in replays.items():
                if not real_eps[sid] or not len(starts[sid]):
                    continue
                moved = []
                for ep in real_eps[sid]:
                    s = int(rng.choice(starts[sid]))
                    moved.append([(s + i - ep[0][0], dp) for i, dp in ep if s + i - ep[0][0] < days])
                fake = [f for ep in moved for f in ep]
                dyn, _ = rp.dynamic(tilt_path(fake, cfg.hold, days), cfg.sensitivity)
                fake_scores += episode_scores(episodes(fake, cfg.hold), dyn, rp.static, eligible[sid])
            ys = list(by_date(fake_scores, calendar).values())
            if ys:
                null.append(sum(ys) / len(ys))
        result["placebo_p"] = (1 + sum(abs(x) >= abs(mean) for x in null)) / (1 + len(null))
    return result


def summary_stats(r: np.ndarray) -> dict[str, float]:
    sd = float(r.std(ddof=1)) if len(r) > 1 else 0.0
    return {"total_return": float(np.prod(1 + r) - 1), "sharpe": float(r.mean() / sd * math.sqrt(252)) if sd else 0.0,
            "max_drawdown": max_drawdown(r)}


def build_basket(series_id: str, model: Any, calendar: list[date], joined: dict[str, date],
                 odds_days: tuple[date, date]) -> Basket:
    T = len(calendar)
    cols = np.full((T, TOP_N), -1, dtype=int)
    betas = np.zeros((T, TOP_N))
    symbols = model.symbols
    monthly: dict[tuple[int, int], tuple[np.ndarray, np.ndarray] | None] = {}
    for t, d in enumerate(calendar):
        key = (d.year, d.month)
        if key not in monthly:
            first = date(d.year, d.month, 1)
            b = model.fit(series_id, d).beta
            ok = np.isfinite(b) & (np.abs(np.nan_to_num(b)) >= MIN_ABS_BETA)
            ok &= np.array([joined.get(s, date.min) < first for s in symbols])
            idx = np.flatnonzero(ok)
            if len(idx) >= TOP_N:
                top = idx[np.argsort(-np.abs(b[idx]), kind="stable")[:TOP_N]]
                monthly[key] = (top, b[top])
            else:
                monthly[key] = None
        if monthly[key] is not None:
            cols[t], betas[t] = monthly[key]
    active = (cols[:, 0] >= 0) & np.array([odds_days[0] <= d <= odds_days[1] for d in calendar])
    return Basket(series_id, cols, betas, active)


async def run(period: research.Period = "dev", placebo: int = 500, seed: int = 7) -> dict[str, Any]:
    from . import history, universe
    from .exposures import ExposureModel, daily_returns

    series_list = await history.load_all()
    model = ExposureModel(series_list)
    r = daily_returns()
    calendar = [d for d in r.index if pd.notna(r.loc[d, "SPY"])]
    # Return from close t to close t+1, per stock, in the model's column order; the last day has none.
    nxt = r.loc[calendar, model.symbols].shift(-1).to_numpy(dtype=float)
    nxt[-1] = np.nan
    joined = {m["yf"]: date.fromisoformat(m["added"]) for m in universe.constituents() if m["added"]}
    in_period = np.array([research.in_period(d, period) for d in calendar])
    in_period[-1] = False  # no next-day return

    replays, eligible, histories = {}, {}, {}
    for s in series_list:
        if not s["rows"]:
            continue
        span = (date.fromisoformat(s["rows"][0]["date"]), date.fromisoformat(s["rows"][-1]["date"]))
        basket = build_basket(s["id"], model, calendar, joined, span)
        replays[s["id"]] = Replay(basket, nxt)
        eligible[s["id"]] = basket.active & in_period
        histories[s["id"]] = history.as_history(s)

    results = []
    for cfg in CONFIGS:
        firings = {sid: [f for f in triggers(histories[sid], calendar, cfg) if replays[sid].basket.active[f[0]]]
                   for sid in replays}
        results.append(run_config(cfg, replays, firings, eligible, calendar, placebo=placebo, seed=seed))
    return {"period": period, "days": int(in_period.sum()), "results": results, "placebo_runs": placebo}


def _print(report: dict[str, Any]) -> None:
    print(f"H3 ({report['period']}): {report['days']} trading days; primary = max drawdown over trigger day → +{WINDOW}, "
          "tilted − static (positive = shallower)\n")
    print(f"  {'cfg':<4}{'episodes':>9}{'dates':>7}{'mean':>10}{'t':>7}{'shallower':>11}{'placebo p':>11}  verdict"
          "   | without largest cluster")
    for res in report["results"]:
        c, rb = res["config"], res["robust"]
        pp = f"{res['placebo_p']:.3f}" if "placebo_p" in res else ""
        tail = (f"{rb['mean'] * 10_000:>7.1f}bp t {rb['t']:>5.2f} (drops {', '.join(rb['dropped'])}) → {res['robust_verdict']}"
                if rb else "")
        print(f"  {c['name']:<4}{res['episodes']:>9}{res['dates']:>7}{res['mean_bp']:>8.1f}bp{res['t']:>7.2f}"
              f"{res['shallower']:>11.0%}{pp:>11}  {res['verdict']:<14}| {tail}")
    print("\n  Secondary (descriptive), tilted vs static over the period:")
    print(f"  {'cfg':<4}{'series':<19}{'days':>5}{'eps':>5}{'return':>16}{'sharpe':>14}{'max dd':>16}{'turnover/day':>16}")
    for res in report["results"]:
        sec = res["secondary"]
        for sid, s in sec.items():
            d, st = s["dynamic"], s["static"]
            print(f"  {res['config']['name']:<4}{sid:<19}{s['days']:>5}{s['episodes']:>5}"
                  f"{d['total_return']:>8.1%} {st['total_return']:>7.1%}{d['sharpe']:>7.2f} {st['sharpe']:>6.2f}"
                  f"{d['max_drawdown']:>8.1%} {st['max_drawdown']:>7.1%}{s['turnover_dynamic']:>8.2%} {s['turnover_static']:>7.2%}")
        if sec:
            avg = lambda f: np.mean([f(s) for s in sec.values()])  # noqa: E731
            print(f"  {res['config']['name']:<4}{'average':<19}{'':>10}"
                  f"{avg(lambda s: s['dynamic']['total_return']):>8.1%} {avg(lambda s: s['static']['total_return']):>7.1%}"
                  f"{avg(lambda s: s['dynamic']['sharpe']):>7.2f} {avg(lambda s: s['static']['sharpe']):>6.2f}"
                  f"{avg(lambda s: s['dynamic']['max_drawdown']):>8.1%} {avg(lambda s: s['static']['max_drawdown']):>7.1%}")
    print("\nTests run: 3 (primary metric for A, B, C), each with a placebo and the cluster rule.")


if __name__ == "__main__":
    import asyncio

    _print(asyncio.run(run(period="holdout" if "--holdout" in sys.argv else "dev")))
