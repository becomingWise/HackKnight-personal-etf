"""Universe-wide βs with industry pooling (empirical Bayes), walk-forward.

For each odds series and each month, every stock's daily abnormal return is
regressed on the series' odds change since the previous trading-day close, over
the prior 12 months. Abnormal return = stock − β_mkt × SPY, with β_mkt from the
prior 252 trading days (so a low-beta stock doesn't look like it "rose" on bad
news), capped at ±20%. Then:

    stock slope b_i (std. error s_i)  ~  N(β_i, s_i²)
    β_i                               ~  N(μ_g, τ²)   g = GICS sub-industry
    μ_g                               ~  N(0, ω²)

τ² and ω² are DerSimonian–Laird (method-of-moments) estimates, so a stock's β is pulled
toward its industry's average, and the industry average toward zero, in
proportion to how noisy each estimate is. Nothing is tuned on outcomes.

β is reported in the app's units (10 × slope: a stock that moves 10% more than
the market per 100-point odds move has β 1.0), capped at ±1.5.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, timedelta
from typing import Any

import numpy as np
import pandas as pd

from . import history, universe

SCALE = 10.0
MAX_BETA = 1.5
RETURN_CAP = 0.20
STALE_RUN = 5
MARKET_WINDOW = 252


@dataclass
class Fit:
    beta: np.ndarray       # pooled β per stock (app units), NaN if not estimable
    raw: np.ndarray        # unpooled slope × SCALE
    se: np.ndarray         # std. error of raw (app units)
    n: np.ndarray          # observations per stock
    symbols: list[str]


def daily_returns() -> pd.DataFrame:
    """Daily returns (SPY included) with stale-price runs masked; not yet capped."""
    frame = pd.read_csv(universe.PRICE_CACHE, index_col=0, parse_dates=True)
    frame.index = frame.index.date
    r = frame.pct_change(fill_method=None)
    # Stale prices: runs of STALE_RUN+ zero returns become missing.
    zero = r.eq(0).astype(float)
    window_end = zero.rolling(STALE_RUN).sum().eq(STALE_RUN)
    stale = window_end.copy()
    for k in range(1, STALE_RUN):
        stale |= window_end.shift(-k, fill_value=False)
    return r.mask(stale)


def market_betas(r: pd.DataFrame, market: str = "SPY") -> pd.DataFrame:
    """β_mkt usable on each date: from the prior MARKET_WINDOW days only (shifted, so no lookahead)."""
    m = r[market]
    win = dict(window=MARKET_WINDOW, min_periods=120)
    cov = r.mul(m, axis=0).rolling(**win).mean() - r.rolling(**win).mean().mul(m.rolling(**win).mean(), axis=0)
    return cov.div(m.rolling(**win).var(ddof=0), axis=0).shift(1)


def before_join(index: pd.Index, columns: pd.Index, members: list[dict[str, Any]], day=lambda x: x) -> pd.DataFrame:
    """True where a stock hadn't yet joined the index (partial survivorship fix)."""
    days = np.array([day(x) for x in index])
    mask = pd.DataFrame(False, index=index, columns=columns)
    for mem in members:
        if mem["added"] and mem["yf"] in columns:
            mask[mem["yf"]] = days < date.fromisoformat(mem["added"])
    return mask


def abnormal_returns(members: list[dict[str, Any]]) -> pd.DataFrame:
    """Daily stock − β_mkt × SPY returns with the pre-registered cleaning rules applied."""
    r = daily_returns()
    ar = (r - market_betas(r).mul(r["SPY"], axis=0)).drop(columns="SPY")
    ar = ar.mask(before_join(ar.index, ar.columns, members))
    return ar.clip(-RETURN_CAP, RETURN_CAP)


def odds_changes(series: dict[str, Any], trading_days: list[date]) -> pd.Series:
    """Chained odds change from one trading-day close to the next (weekend moves roll forward)."""
    levels = {date.fromisoformat(r["date"]): None for r in series["rows"]}
    path = history.as_history(series)
    for row, point in zip(series["rows"], path):
        levels[date.fromisoformat(row["date"])] = point["p"]
    s = pd.Series({d: levels[d] for d in trading_days if d in levels}, dtype=float)
    return s.diff().dropna()


def fit_window(x: np.ndarray, Y: np.ndarray, groups: np.ndarray, min_obs: int = 120) -> tuple[np.ndarray, ...]:
    """Per-column OLS of Y on x with missing values, then two-level shrinkage."""
    mask = ~np.isnan(Y)
    n = mask.sum(0)
    X = np.where(mask, x[:, None], 0.0)
    Yz = np.where(mask, Y, 0.0)
    with np.errstate(invalid="ignore", divide="ignore"):
        mx, my = X.sum(0) / n, Yz.sum(0) / n
        dx = np.where(mask, X - mx, 0.0)
        dy = np.where(mask, Yz - my, 0.0)
        sxx = (dx * dx).sum(0)
        b = (dx * dy).sum(0) / sxx
        resid = np.where(mask, dy - b * dx, 0.0)
        se = np.sqrt((resid * resid).sum(0) / (n - 2) / sxx)
    ok = (n >= min_obs) & np.isfinite(b) & np.isfinite(se) & (se > 0)
    b, se = np.where(ok, b * SCALE, np.nan), np.where(ok, se * SCALE, np.nan)

    pooled = np.full_like(b, np.nan)
    if ok.sum() < 10:
        return pooled, b, se, n
    idx = np.where(ok)[0]
    bi, vi, gi = b[idx], se[idx] ** 2, groups[idx]
    labels = np.unique(gi)

    # τ² (stocks around their industry mean), DerSimonian–Laird with fixed-effect group means.
    w = 1 / vi
    q = dof = denom = 0.0
    for g in labels:
        k = gi == g
        if k.sum() < 2:
            continue
        mean_g = (w[k] * bi[k]).sum() / w[k].sum()
        q += (w[k] * (bi[k] - mean_g) ** 2).sum()
        dof += k.sum() - 1
        denom += w[k].sum() - (w[k] ** 2).sum() / w[k].sum()
    tau2 = max((q - dof) / denom, 0.0) if denom > 0 else 0.0

    # Industry means given τ², then ω² (industry means around zero), DL with the mean fixed at 0.
    mu = np.empty(len(labels))
    V = np.empty(len(labels))
    for j, g in enumerate(labels):
        k = gi == g
        wg = 1 / (vi[k] + tau2)
        mu[j], V[j] = (wg * bi[k]).sum() / wg.sum(), 1 / wg.sum()
    W = 1 / V
    denom_w = W.sum() - (W**2).sum() / W.sum()
    if denom_w > 0:
        omega2 = max(((W * mu**2).sum() - len(mu)) / denom_w, 0.0)
    else:  # a single industry: plain moment estimate
        omega2 = max(float(np.mean(mu**2 - V)), 0.0)

    mu_star = dict(zip(labels, mu * omega2 / (omega2 + V)))
    for i, b_i, v_i, g in zip(idx, bi, vi, gi):
        # Precision-weighted between the stock's own estimate and its shrunk industry mean.
        beta = mu_star[g] if tau2 == 0 else (b_i / v_i + mu_star[g] / tau2) / (1 / v_i + 1 / tau2)
        pooled[i] = np.clip(beta, -MAX_BETA, MAX_BETA)
    return pooled, b, se, n


class ExposureModel:
    def __init__(self, series_list: list[dict[str, Any]], *, window_days: int = 365, min_obs: int = 120):
        members = universe.constituents()
        self.ar = abnormal_returns(members)
        self.symbols = list(self.ar.columns)
        industry = {m["yf"]: m["sub_industry"] for m in members}
        self.groups = np.array([industry.get(s, "Other") for s in self.symbols])
        days = list(self.ar.index)
        self.x = {s["id"]: odds_changes(s, days) for s in series_list}
        self.window_days, self.min_obs = window_days, min_obs
        self._cache: dict[tuple[str, int, int], Fit] = {}

    def fit(self, series_id: str, d: date) -> Fit:
        """Fit usable on date d: data strictly before the first of d's month."""
        key = (series_id, d.year, d.month)
        if key not in self._cache:
            cutoff = date(d.year, d.month, 1)
            x = self.x[series_id]
            x = x[(x.index >= cutoff - timedelta(days=self.window_days)) & (x.index < cutoff)]
            Y = self.ar.loc[x.index].to_numpy(dtype=float)
            beta, raw, se, n = fit_window(x.to_numpy(dtype=float), Y, self.groups, self.min_obs)
            self._cache[key] = Fit(beta, raw, se, n, self.symbols)
        return self._cache[key]

    def at(self, series_id: str, d: date, min_abs: float = 0.05) -> dict[str, float]:
        f = self.fit(series_id, d)
        return {s: float(b) for s, b in zip(f.symbols, f.beta) if np.isfinite(b) and abs(b) >= min_abs}


def benjamini_hochberg(pvalues: np.ndarray, q: float = 0.10) -> np.ndarray:
    """Boolean mask of discoveries at false discovery rate q."""
    p = np.asarray(pvalues)
    order = np.argsort(p)
    ranked = p[order] * len(p) / (np.arange(len(p)) + 1)
    passed = np.zeros(len(p), dtype=bool)
    below = np.where(ranked <= q)[0]
    if len(below):
        passed[order[: below.max() + 1]] = True
    return passed
