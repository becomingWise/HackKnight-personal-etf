"""H2: is the exposure ranking real? Cross-sectional dose-response on daily spike dates.

Pre-registered in research/PREREGISTRATION.md (H2). On each daily spike date
(`eventstudy.find_spikes` defaults), every universe stock's day-0 abnormal return
is regressed on its predicted move:

    AR_i,0 = a + b · pred_i + e_i        pred_i = Σ_spikes β_i,s × Δp_s / SCALE

β are the walk-forward, industry-pooled exposures (`ExposureModel`) usable on that
date; dividing by SCALE turns app units back into return per unit of odds, so
b = 1 means the βs are calibrated. AR is the market-model abnormal return,
capped at ±20% (amendments 2, 4). Spikes from several series on one trading day
add into one prediction, so there is one slope per date (Fama–MacBeth), and the
test is across dates.

- H2a: mean slope > 0 (primary, t > 3 to count as evidence).
- H2b: top-minus-bottom quintile of pred, day-0 AR spread > 0.
- H2c: slope on dates whose spike contracts have above-median volume > below.
Each gets a placebo: the same spikes moved to random dates (500 runs, two-sided).

Run `uv run python -m polyslice_api.crosssection` (`--holdout` once, at the end).
"""

from __future__ import annotations

import bisect
import math
import random
import sys
from datetime import date
from typing import Any, Callable

import numpy as np
import pandas as pd

from . import research
from .exposures import SCALE

MIN_STOCKS = 50
QUINTILE = 0.2
EVIDENCE_T, SUGGESTIVE_T = 3.0, 2.0

BetaFn = Callable[[str, date], np.ndarray]  # β per column of the abnormal-return frame (NaN if none)


def date_stats(pred: np.ndarray, ar: np.ndarray) -> dict[str, float] | None:
    """OLS slope of AR on pred across stocks, and the top-minus-bottom quintile AR spread."""
    ok = np.isfinite(pred) & np.isfinite(ar)
    x, y = pred[ok], ar[ok]
    if len(x) < MIN_STOCKS or not np.ptp(x):
        return None
    dx = x - x.mean()
    slope = float((dx * (y - y.mean())).sum() / (dx * dx).sum())
    order = np.argsort(x, kind="stable")
    k = max(1, int(len(x) * QUINTILE))
    spread = float(y[order[-k:]].mean() - y[order[:k]].mean())
    return {"slope": slope, "spread": spread, "stocks": int(len(x))}


class CrossSection:
    def __init__(self, ar: pd.DataFrame, betas: BetaFn):
        self.calendar = list(ar.index)
        self.values = ar.to_numpy(dtype=float)
        self.betas = betas

    def anchor(self, d: date) -> int | None:
        """First trading day on or after d (weekend and holiday moves count on the next session)."""
        i = bisect.bisect_left(self.calendar, d)
        return i if i < len(self.calendar) else None

    def score(self, spikes: list[dict[str, Any]], volume_median: float | None = None) -> list[dict[str, Any]]:
        """One row per trading day: slope, spread and (if a median is given) the dates' volume group."""
        by_day: dict[int, list[dict[str, Any]]] = {}
        for sp in spikes:
            i = self.anchor(date.fromisoformat(sp["date"]))
            if i is not None:
                by_day.setdefault(i, []).append(sp)
        out = []
        for i, group in sorted(by_day.items()):
            pred = np.zeros(self.values.shape[1])
            for sp in group:
                pred = pred + self.betas(sp["series"], date.fromisoformat(sp["date"])) * sp["dp"] / SCALE
            stats = date_stats(pred, self.values[i])
            if stats is None:
                continue
            row = {"trading_day": self.calendar[i].isoformat(), "spikes": len(group), **stats}
            if volume_median is not None:
                high = {sp["volume"] > volume_median for sp in group}
                row["volume"] = ("high" if high == {True} else "low") if len(high) == 1 else "mixed"
            out.append(row)
        return out


def t_stat(xs: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mean = sum(xs) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in xs) / (n - 1))
    return mean / (sd / math.sqrt(n)) if sd else 0.0


def welch_t(a: list[float], b: list[float]) -> float:
    if len(a) < 2 or len(b) < 2:
        return 0.0
    va, vb = np.var(a, ddof=1), np.var(b, ddof=1)
    se = math.sqrt(va / len(a) + vb / len(b))
    return float((np.mean(a) - np.mean(b)) / se) if se else 0.0


def verdict(t: float) -> str:
    return "evidence" if t > EVIDENCE_T else "suggestive" if t > SUGGESTIVE_T else "not supported"


def statistics(rows: list[dict[str, Any]]) -> dict[str, float]:
    """The three test statistics: mean slope, mean spread, high-minus-low volume slope."""
    slopes = [r["slope"] for r in rows]
    high = [r["slope"] for r in rows if r.get("volume") == "high"]
    low = [r["slope"] for r in rows if r.get("volume") == "low"]
    return {
        "H2a": float(np.mean(slopes)) if slopes else math.nan,
        "H2b": float(np.mean([r["spread"] for r in rows])) if rows else math.nan,
        "H2c": float(np.mean(high) - np.mean(low)) if high and low else math.nan,
    }


def summarize(rows: list[dict[str, Any]], placebo: list[list[dict[str, Any]]] | None = None) -> dict[str, Any]:
    stats = statistics(rows)
    high = [r["slope"] for r in rows if r.get("volume") == "high"]
    low = [r["slope"] for r in rows if r.get("volume") == "low"]
    tests = {
        "H2a": {"label": "mean slope", "value": stats["H2a"], "t": t_stat([r["slope"] for r in rows]),
                "dates": len(rows), "positive": sum(r["slope"] > 0 for r in rows) / len(rows) if rows else math.nan},
        "H2b": {"label": "top − bottom quintile, bp", "value": stats["H2b"] * 10_000,
                "t": t_stat([r["spread"] for r in rows]), "dates": len(rows),
                "positive": sum(r["spread"] > 0 for r in rows) / len(rows) if rows else math.nan},
        "H2c": {"label": "slope high − low volume", "value": stats["H2c"], "t": welch_t(high, low),
                "dates": len(high) + len(low), "high": len(high), "low": len(low),
                "high_slope": float(np.mean(high)) if high else math.nan,
                "low_slope": float(np.mean(low)) if low else math.nan,
                "mixed_excluded": sum(r.get("volume") == "mixed" for r in rows)},
    }
    for name, row in tests.items():
        row["verdict"] = verdict(row["t"])
        if placebo:
            null = [statistics(run)[name] for run in placebo]
            null = [x for x in null if not math.isnan(x)]
            if null and not math.isnan(stats[name]):
                row["placebo_p"] = (1 + sum(1 for x in null if abs(x) >= abs(stats[name]))) / (1 + len(null))
    return {"dates": len(rows), "tests": tests}


def tag_volume(spikes: list[dict[str, Any]], series_list: list[dict[str, Any]]) -> list[dict[str, Any]]:
    meta = {(s["id"], c["event"]): c["volume"] for s in series_list for c in s["contracts"]}
    return [{**sp, "volume": meta[(sp["series"], sp["contract"])]} for sp in spikes]


async def run(period: research.Period = "dev", placebo: int = 500, seed: int = 7) -> dict[str, Any]:
    from . import history
    from .eventstudy import find_spikes
    from .exposures import ExposureModel

    series_list = await history.load_all()
    model = ExposureModel(series_list)

    def betas(series_id: str, d: date) -> np.ndarray:
        return model.fit(series_id, d).beta

    xs = CrossSection(model.ar, betas)
    spikes = tag_volume([sp for s in series_list for sp in find_spikes(s)], series_list)
    spikes = [sp for sp in spikes if research.in_period(sp["date"], period)]
    volume_median = float(np.median([sp["volume"] for sp in spikes])) if spikes else 0.0
    rows = xs.score(spikes, volume_median)

    runs = []
    if placebo:
        rng = random.Random(seed)
        days = {s["id"]: [r["date"] for r in s["rows"] if r["dp"] is not None and research.in_period(r["date"], period)]
                for s in series_list}
        for _ in range(placebo):
            fake = [{**sp, "date": rng.choice(days[sp["series"]])} for sp in spikes if days[sp["series"]]]
            runs.append(xs.score(fake, volume_median))

    return {
        "period": period,
        "spikes": len(spikes),
        "by_series": {s["id"]: sum(1 for sp in spikes if sp["series"] == s["id"]) for s in series_list},
        "volume_median": volume_median,
        "summary": summarize(rows, runs or None),
        "rows": rows,
        "placebo_runs": placebo,
    }


def _print(report: dict[str, Any]) -> None:
    s = report["summary"]
    print(f"H2 ({report['period']}): {report['spikes']} spikes on {s['dates']} scored dates: {report['by_series']}")
    print(f"Volume median ${report['volume_median'] / 1e6:.1f}M\n")
    print(f"  {'test':<5}{'statistic':<28}{'value':>9}{'t':>7}{'dates':>7}{'placebo p':>11}  verdict")
    for name, r in s["tests"].items():
        pp = f"{r['placebo_p']:.3f}" if "placebo_p" in r else ""
        print(f"  {name:<5}{r['label']:<28}{r['value']:>9.3f}{r['t']:>7.2f}{r['dates']:>7}{pp:>11}  {r['verdict']}")
    c = s["tests"]["H2c"]
    print(f"\n  H2c: high-volume slope {c['high_slope']:.3f} (n={c['high']}), low {c['low_slope']:.3f} (n={c['low']}), "
          f"{c['mixed_excluded']} mixed dates excluded")
    print("  Slope 1.0 = βs calibrated; 0 = ranking carries no information.")
    print("\nTests run: 3 (H2a primary, H2b, H2c), each with a placebo.")


if __name__ == "__main__":
    import asyncio

    _print(asyncio.run(run(period="holdout" if "--holdout" in sys.argv else "dev")))
