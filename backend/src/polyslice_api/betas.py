"""Sensitivities (βs) estimated from data, walk-forward so they never see the future.

At the start of each month, for every stock, regress its daily market-adjusted
return (stock minus SPY) on each series' same-day odds change, using only the
`window_days` before that month. The slope is converted to β units (β = 10 ×
slope, so a stock that moves 10% for a 100-point odds move has β 1.0), capped at
±1.5, and shrunk by confidence:

    β = (t² · β_data + shrink · β_prior) / (t² + shrink)

With shrink 4, an estimate at |t| = 2 gets half weight. The prior is either the
hand-picked guess ("blend") or 0 ("data").
"""

from __future__ import annotations

import bisect
import math
from datetime import date, timedelta
from typing import Any

SCALE = 10.0
# Same range as the hand-picked βs; series with tiny odds moves otherwise give huge, noisy slopes.
MAX_BETA = 1.5


class BetaModel:
    def __init__(
        self,
        series_list: list[dict[str, Any]],
        closes: dict[str, dict[date, float]],
        symbols: list[str],
        *,
        prior: str = "blend",
        window_days: int = 365,
        min_obs: int = 120,
        shrink: float = 4.0,
        market: str = "SPY",
    ):
        self.prior = {s["id"]: (s["betas"] if prior == "blend" else {}) for s in series_list}
        self.window_days, self.min_obs, self.shrink = window_days, min_obs, shrink
        calendar = sorted(closes[market])
        index = {d: i for i, d in enumerate(calendar)}

        def ar(symbol: str, i: int) -> float | None:
            c = closes.get(symbol, {})
            prev, cur, mp, mc = c.get(calendar[i - 1]), c.get(calendar[i]), closes[market].get(calendar[i - 1]), closes[market].get(calendar[i])
            return cur / prev - mc / mp if prev and cur and mp and mc else None

        # Per series: sorted dates, odds changes, and each symbol's abnormal return that day.
        self.obs: dict[str, tuple[list[date], list[float], dict[str, list[float | None]]]] = {}
        for s in series_list:
            dates, dps, rets = [], [], {sym: [] for sym in symbols}
            for row in s["rows"]:
                d = date.fromisoformat(row["date"])
                i = index.get(d)
                if row["dp"] is None or not i:
                    continue
                dates.append(d)
                dps.append(row["dp"])
                for sym in symbols:
                    rets[sym].append(ar(sym, i))
            self.obs[s["id"]] = (dates, dps, rets)
        self._cache: dict[tuple[str, int, int], dict[str, float]] = {}

    def at(self, series_id: str, d: date) -> dict[str, float]:
        """βs usable on date `d`: fitted on data strictly before the first of d's month."""
        key = (series_id, d.year, d.month)
        if key not in self._cache:
            self._cache[key] = self._fit(series_id, date(d.year, d.month, 1))
        return self._cache[key]

    def _fit(self, series_id: str, cutoff: date) -> dict[str, float]:
        dates, dps, rets = self.obs[series_id]
        lo = bisect.bisect_left(dates, cutoff - timedelta(days=self.window_days))
        hi = bisect.bisect_left(dates, cutoff)
        prior = self.prior[series_id]
        out = {}
        for sym, ys in rets.items():
            pairs = [(dps[i], ys[i]) for i in range(lo, hi) if ys[i] is not None]
            fit = regress(pairs) if len(pairs) >= self.min_obs else None
            p = prior.get(sym, 0.0)
            if fit is None:
                beta = p
            else:
                slope, t = fit
                w = t * t
                data = max(-MAX_BETA, min(MAX_BETA, SCALE * slope))
                beta = (w * data + self.shrink * p) / (w + self.shrink)
            if abs(beta) >= 0.05:
                out[sym] = beta
        return out


def regress(pairs: list[tuple[float, float]]) -> tuple[float, float] | None:
    """OLS slope of y on x and its t-stat."""
    n = len(pairs)
    mx = sum(x for x, _ in pairs) / n
    my = sum(y for _, y in pairs) / n
    sxx = sum((x - mx) ** 2 for x, _ in pairs)
    if not sxx or n < 3:
        return None
    slope = sum((x - mx) * (y - my) for x, y in pairs) / sxx
    resid = sum((y - my - slope * (x - mx)) ** 2 for x, y in pairs)
    se = math.sqrt(resid / (n - 2) / sxx)
    return slope, (slope / se if se else 0.0)
