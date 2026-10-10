"""H1: is there time to act? Intraday lead-lag around hourly odds spikes.

Pre-registered in research/PREREGISTRATION.md (H1). For each hourly spike, the
20 stocks most exposed to that series (largest |β| from the walk-forward,
industry-pooled `ExposureModel`) are scored bar by bar from −6 to +6 hourly
bars around the spike:

    score_k = Σ |β_i| · sign(Δp) · sign(β_i) · AR_{i,k} / Σ |β_i|
    AR_{i,k} = r_{i,k} − β_mkt,i × r_SPY,k          (amendment 4; uncapped, amendment 2)

β_mkt is the daily market β from the prior 252 trading days, as for the daily
tests. H1a: Σ score_{+1..+6} > 0 (a window to act exists). H1b: Σ score_{−6..−1}
> 0 (stocks lead the odds).

Timing conventions (implementation of the pre-registered window, fixed before
running): odds are sampled at HH:30 UTC, the boundaries of US stocks' hourly bars
(9:30 ET open), so an hourly odds change spans exactly one stock bar. "Occurring
14:30–20:00 UTC" means the whole hour of the odds change lies inside that window
(it ends at 15:30, 16:30, …, 19:30 UTC), which is inside the session in both
EST and EDT, and the matching SPY bar must exist (drops holidays and half-day
afternoons). Bar 0 is that bar: the simultaneous reaction. Offsets count
trading bars, so +1..+6 is buying at the close of bar 0 and holding six bars;
a window that crosses the close includes the overnight move in the next
session's first bar.

Run `uv run python -m polyslice_api.intraday` (add `--holdout` for the holdout,
once, at the end). Needs the daily caches (`history`, `universe`) and fetches
hourly bars, which Yahoo serves for the last ~730 days only.
"""

from __future__ import annotations

import math
import random
import sys
from datetime import date, datetime, time as dtime, timedelta, timezone
from typing import Any, Callable

import numpy as np
import pandas as pd

from . import research, universe

HOURLY_CACHE = universe.PRICE_CACHE.parent / "hourly.csv.gz"
OFFSETS = range(-6, 7)
PRE, POST = range(-6, 0), range(1, 7)
TOP_N = 20
SESSION = (dtime(14, 30), dtime(20, 0))  # UTC
EVIDENCE_T, SUGGESTIVE_T = 3.0, 2.0


def find_hourly_spikes(
    series: dict[str, Any],
    bar_starts: set[datetime],
    *,
    z_threshold: float = 3.0,
    min_move: float = 0.03,
    vol_window: int = 7 * 24,
    min_volume: float = 1_000_000,
    cooldown_hours: int = 6,
) -> list[dict[str, Any]]:
    """Pre-registered hourly spikes: |Δp| ≥ 3 pts, |z| ≥ 3 vs the prior 7 days (168) of hourly changes,
    contract volume ≥ $1M, 6-hour cooldown, the change's hour inside 14:30–20:00 UTC on a trading day.

    `bar_starts` are the market's hourly bar start times (UTC); the change ending at t must match the
    bar starting at t − 1h. z uses the prior changes of the chained series, as `eventstudy.find_spikes`
    does (σ floored at 0.5 pt, which only avoids dividing by zero: any 3-pt move then has |z| ≥ 6).
    """
    meta = {c["event"]: c for c in series["contracts"]}
    history: list[float] = []
    out: list[dict[str, Any]] = []
    last: datetime | None = None
    for row in series["rows"]:
        dp = row["dp"]
        if dp is None:
            continue
        t = datetime.fromisoformat(row["t"])
        start = t - timedelta(hours=1)
        if len(history) >= vol_window:
            window = history[-vol_window:]
            mean = sum(window) / len(window)
            sd = max(math.sqrt(sum((x - mean) ** 2 for x in window) / (len(window) - 1)), 0.005)
            z = dp / sd
            if (
                abs(z) >= z_threshold
                and abs(dp) >= min_move
                and meta[row["contract"]]["volume"] >= min_volume
                and start.date() == t.date()
                and SESSION[0] <= start.time() and t.time() <= SESSION[1]
                and start in bar_starts
                and (last is None or (t - last) > timedelta(hours=cooldown_hours))
            ):
                out.append({"series": series["id"], "t": row["t"], "dp": dp, "p": row["p"], "z": z,
                            "contract": row["contract"]})
                last = t
        history.append(dp)
    return out


def download_hourly(symbols: list[str]) -> pd.DataFrame:
    """Hourly closes indexed by bar start (UTC), regular session only."""
    import yfinance as yf

    start = (datetime.now(timezone.utc) - timedelta(days=729)).date().isoformat()
    data = yf.download(symbols, start=start, interval="60m", progress=False, auto_adjust=True,
                       prepost=False, threads=True)
    closes = data["Close"].dropna(how="all")
    closes.index = pd.DatetimeIndex(closes.index).tz_convert("UTC")
    return closes


def hourly_closes(refresh: bool = False) -> pd.DataFrame:
    if refresh or not HOURLY_CACHE.exists():
        symbols = sorted({m["yf"] for m in universe.constituents()} | {"SPY"})
        frame = download_hourly(symbols)
        HOURLY_CACHE.parent.mkdir(parents=True, exist_ok=True)
        frame.to_csv(HOURLY_CACHE)
    frame = pd.read_csv(HOURLY_CACHE, index_col=0)
    frame.index = pd.to_datetime(frame.index, utc=True)
    return frame


def hourly_abnormal(closes: pd.DataFrame, beta_mkt: pd.DataFrame, members: list[dict[str, Any]],
                    market: str = "SPY") -> pd.DataFrame:
    """Bar-to-bar abnormal returns: r_i − β_mkt,i(day) × r_SPY, indexed by bar start (UTC). Uncapped."""
    from .exposures import before_join

    r = closes.pct_change(fill_method=None)
    days = [ts.date() for ts in r.index]
    b = beta_mkt.reindex(index=sorted(set(days)), columns=r.columns)
    b = b.loc[days]
    b.index = r.index
    ar = (r - b.mul(r[market], axis=0)).drop(columns=market)
    return ar.mask(before_join(ar.index, ar.columns, members, day=lambda ts: ts.date()))


def top_exposed(betas: dict[str, float], n: int = TOP_N) -> dict[str, float]:
    return dict(sorted(betas.items(), key=lambda kv: (-abs(kv[1]), kv[0]))[:n])


class Scorer:
    """Scores spikes against hourly abnormal returns, numpy-backed so placebo runs are cheap."""

    def __init__(self, ar: pd.DataFrame, betas: Callable[[str, date], dict[str, float]], top_n: int = TOP_N):
        self.bars = list(ar.index.to_pydatetime())
        self.pos = {t: i for i, t in enumerate(self.bars)}
        self.col = {s: j for j, s in enumerate(ar.columns)}
        self.values = ar.to_numpy(dtype=float)
        self.betas, self.top_n = betas, top_n

    def score(self, spike: dict[str, Any]) -> dict[str, Any] | None:
        t = datetime.fromisoformat(spike["t"])
        i0 = self.pos.get(t - timedelta(hours=1))
        if i0 is None or i0 + min(OFFSETS) < 1 or i0 + max(OFFSETS) >= len(self.bars):
            return None
        exposed = {s: b for s, b in self.betas(spike["series"], t.date()).items() if s in self.col}
        exposed = top_exposed(exposed, self.top_n)
        if not exposed:
            return None
        cols = np.array([self.col[s] for s in exposed])
        beta = np.array(list(exposed.values()))
        signed = math.copysign(1.0, spike["dp"]) * np.sign(beta)
        block = self.values[i0 + min(OFFSETS): i0 + max(OFFSETS) + 1][:, cols]
        ok = ~np.isnan(block)
        w = np.where(ok, np.abs(beta), 0.0)
        with np.errstate(invalid="ignore", divide="ignore"):
            path = (np.where(ok, block, 0.0) * signed * w).sum(1) / w.sum(1)
        scores = dict(zip(OFFSETS, path.tolist()))
        if any(math.isnan(scores[k]) for k in (*PRE, *POST)):
            return None
        return {**spike, "trading_day": self.bars[i0].date().isoformat(), "bar": self.bars[i0].isoformat(),
                "stocks": list(exposed), "path": scores,
                "pre": sum(scores[k] for k in PRE), "post": sum(scores[k] for k in POST)}

    def score_all(self, spikes: list[dict[str, Any]]) -> list[dict[str, Any]]:
        return [e for e in map(self.score, spikes) if e is not None]


def by_date(events: list[dict[str, Any]], key: Callable[[dict[str, Any]], float]) -> list[float]:
    """One value per trading day (spikes on the same day averaged): the date-clustered sample."""
    groups: dict[str, list[float]] = {}
    for e in events:
        v = key(e)
        if not math.isnan(v):
            groups.setdefault(e["trading_day"], []).append(v)
    return [sum(v) / len(v) for v in groups.values()]


def t_stat(xs: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mean = sum(xs) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in xs) / (n - 1))
    return mean / (sd / math.sqrt(n)) if sd else 0.0


def verdict(t: float) -> str:
    return "evidence" if t > EVIDENCE_T else "suggestive" if t > SUGGESTIVE_T else "not supported"


def placebo_times(series_hourly: list[dict[str, Any]], bar_starts: set[datetime],
                  period: research.Period) -> dict[str, list[str]]:
    """Per series: every in-session hour (as `find_hourly_spikes` defines it) with a chained change."""
    out = {}
    for s in series_hourly:
        ts = []
        for row in s["rows"]:
            if row["dp"] is None:
                continue
            t = datetime.fromisoformat(row["t"])
            start = t - timedelta(hours=1)
            if (start in bar_starts and SESSION[0] <= start.time() and t.time() <= SESSION[1]
                    and research.in_period(t.date(), period)):
                ts.append(row["t"])
        out[s["id"]] = ts
    return out


def summarize(events: list[dict[str, Any]], placebo: list[list[dict[str, Any]]] | None = None) -> dict[str, Any]:
    tests = {}
    for name, key in (("H1a post +1..+6", lambda e: e["post"]), ("H1b pre -6..-1", lambda e: e["pre"])):
        xs = by_date(events, key)
        mean = sum(xs) / len(xs) if xs else float("nan")
        row = {"dates": len(xs), "mean_bp": mean * 10_000, "t": t_stat(xs),
               "hit_rate": sum(1 for x in xs if x > 0) / len(xs) if xs else float("nan")}
        row["verdict"] = verdict(row["t"])
        if placebo:
            null = [sum(p) / len(p) for p in (by_date(run, key) for run in placebo) if p]
            row["placebo_p"] = (1 + sum(1 for x in null if abs(x) >= abs(mean))) / (1 + len(null))
        tests[name] = row
    profile = []
    for k in OFFSETS:
        xs = by_date(events, lambda e, k=k: e["path"][k])
        profile.append({"bar": k, "dates": len(xs), "mean_bp": (sum(xs) / len(xs) if xs else float("nan")) * 10_000,
                        "t": t_stat(xs)})
    return {"spikes": len(events), "dates": len({e["trading_day"] for e in events}), "tests": tests, "profile": profile}


async def run(period: research.Period = "dev", placebo: int = 500, seed: int = 7, refresh: bool = False) -> dict[str, Any]:
    from . import history
    from .exposures import ExposureModel, daily_returns, market_betas

    daily_series = await history.load_all()
    hourly_series = await history.load_all_hourly(refresh)
    model = ExposureModel(daily_series)
    members = universe.constituents()
    closes = hourly_closes(refresh)
    ar = hourly_abnormal(closes, market_betas(daily_returns()), members)
    bar_starts = set(closes["SPY"].dropna().index.to_pydatetime())
    first_bar = min(bar_starts)

    spikes = [sp for s in hourly_series for sp in find_hourly_spikes(s, bar_starts)
              if research.in_period(sp["t"][:10], period) and datetime.fromisoformat(sp["t"]) > first_bar]
    scorer = Scorer(ar, model.at)
    events = scorer.score_all(spikes)

    runs = []
    if placebo:
        rng = random.Random(seed)
        pool = placebo_times(hourly_series, bar_starts, period)
        for _ in range(placebo):
            fake = [{**sp, "t": rng.choice(pool[sp["series"]])} for sp in spikes if pool[sp["series"]]]
            runs.append(scorer.score_all(fake))

    return {
        "period": period,
        "hourly_coverage": [first_bar.isoformat(), max(bar_starts).isoformat()],
        "by_series": {s["id"]: sum(1 for e in events if e["series"] == s["id"]) for s in hourly_series},
        "summary": summarize(events, runs or None),
        "per_series": {s["id"]: summarize([e for e in events if e["series"] == s["id"]]) for s in hourly_series},
        "events": events,
        "placebo_runs": placebo,
    }


def _print(report: dict[str, Any]) -> None:
    s = report["summary"]
    print(f"H1 ({report['period']}), hourly bars {report['hourly_coverage'][0][:10]} → {report['hourly_coverage'][1][:10]}")
    print(f"{s['spikes']} scored spikes on {s['dates']} dates: {report['by_series']}")
    print(f"\n  {'test':<18}{'dates':>6}{'mean':>9}{'t':>7}{'hit':>7}{'placebo p':>11}  verdict")
    for name, r in s["tests"].items():
        pp = f"{r['placebo_p']:.3f}" if "placebo_p" in r else ""
        print(f"  {name:<18}{r['dates']:>6}{r['mean_bp']:>7.1f}bp{r['t']:>7.2f}{r['hit_rate']:>7.0%}{pp:>11}  {r['verdict']}")
    print("\n  bar  mean     t   (score > 0 = moved the way β predicted)")
    for r in s["profile"]:
        print(f"  {r['bar']:>+3} {r['mean_bp']:>6.1f}bp {r['t']:>5.2f}")
    print("\n  per series        dates  post +1..+6       pre -6..-1")
    for sid, ps in report["per_series"].items():
        a, b = ps["tests"]["H1a post +1..+6"], ps["tests"]["H1b pre -6..-1"]
        if a["dates"]:
            print(f"  {sid:<18}{a['dates']:>5}  {a['mean_bp']:>6.1f}bp t {a['t']:>5.2f}  {b['mean_bp']:>6.1f}bp t {b['t']:>5.2f}")
    print("\nTests run: 2 (H1a primary, H1b), each with a placebo; the bar profile and per-series rows are descriptive.")


if __name__ == "__main__":
    import asyncio

    _print(asyncio.run(run(period="holdout" if "--holdout" in sys.argv else "dev", refresh="--refresh" in sys.argv)))
