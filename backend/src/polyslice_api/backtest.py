"""Historical replay: the dynamic basket vs. the same basket held at base weights.

Each trading day t, weights are set at the close using only odds known by then
(the last Polymarket print at or before the close) and held to the next close.
Both portfolios rebalance daily, so the only difference is the Polymarket tilt.

Two modes:
- "continuous": every odds move over the look-back tilts the basket.
- "spike": only moves that are unusually large for that market (|z| >= z_threshold,
  scaled by its own recent daily volatility) tilt the basket; the tilt is held for
  `hold_days` trading days, then the basket reverts to base weights.
"""

from __future__ import annotations

import bisect
import math
from datetime import date, datetime, time, timezone
from typing import Any

from . import engine

DAY = 86_400
# Floor on daily odds volatility so a market that never moves can't produce huge z-scores.
MIN_DAILY_VOL = 0.005
# 16:00 New York is 20:00 or 21:00 UTC; 20:00 never peeks past the close.
CLOSE_UTC = time(20, 0)


def close_ts(d: date) -> int:
    return int(datetime.combine(d, CLOSE_UTC, tzinfo=timezone.utc).timestamp())


def odds_at(history: list[dict[str, float]], ts: int) -> float | None:
    """Last probability printed at or before `ts` (history sorted by t)."""
    i = bisect.bisect_right([h["t"] for h in history], ts)
    return history[i - 1]["p"] if i else None


def spike_z(history: list[dict[str, float]], now: int, lookback_days: int, vol_window: int) -> float | None:
    """The look-back move in units of the market's normal noise before that move.

    Noise is the std of daily odds changes over the `vol_window` days ending where
    the look-back starts, so the move being measured never inflates its own yardstick.
    """
    ref = now - lookback_days * DAY
    p_now, p_ref = odds_at(history, now), odds_at(history, ref)
    path = [odds_at(history, ref - k * DAY) for k in range(vol_window, -1, -1)]
    if p_now is None or p_ref is None or any(p is None for p in path):
        return None
    diffs = [b - a for a, b in zip(path, path[1:])]
    mean = sum(diffs) / len(diffs)
    sd = math.sqrt(sum((d - mean) ** 2 for d in diffs) / (len(diffs) - 1))
    return (p_now - p_ref) / (max(sd, MIN_DAILY_VOL) * math.sqrt(lookback_days))


def simulate(
    holdings: list[dict[str, Any]],
    signals: list[dict[str, Any]],
    odds: dict[str, list[dict[str, float]]],
    closes: dict[str, dict[date, float]],
    *,
    lookback_days: int = 7,
    sensitivity: float = 2.0,
    cost_bps: float = 5.0,
    mode: str = "continuous",
    z_threshold: float = 2.0,
    hold_days: int = 10,
    vol_window: int = 30,
) -> dict[str, Any]:
    symbols = [h["symbol"] for h in holdings]
    days = sorted(set.intersection(*(set(closes.get(s, {})) for s in symbols))) if symbols else []
    if len(days) < 2:
        return {"dates": [], "dynamic": [], "static": [], "weights": {}, "stats": None, "moments": [], "spikes": []}

    by_id = {s["id"]: s for s in signals}
    dyn_value, static_value = 1.0, 1.0
    out_dates, dyn_curve, static_curve = [days[0].isoformat()], [1.0], [1.0]
    weight_hist: dict[str, list[float]] = {s: [] for s in symbols}
    dyn_returns, static_returns, turnovers = [], [], []
    prev: dict[str, float] | None = None
    moments, spikes = [], []
    active: dict[str, dict[str, float]] = {}  # spike mode: signal id -> held tilt

    for i, (today, tomorrow) in enumerate(zip(days, days[1:])):
        now = close_ts(today)
        snapshot = []
        for sid, s in by_id.items():
            history = odds.get(sid, [])
            p_now = odds_at(history, now)
            p_ref = odds_at(history, now - lookback_days * DAY)
            if p_now is None or p_ref is None:
                continue
            if mode == "continuous":
                snapshot.append({**s, "price": p_now, "changes": {"bt": p_now - p_ref}})
                continue
            z = spike_z(history, now, lookback_days, vol_window)
            if z is not None and abs(z) >= z_threshold:
                active[sid] = {"price": p_now, "delta": p_now - p_ref, "until": i + hold_days}
                spikes.append({"date": today.isoformat(), "signal": sid, "label": s["label"],
                               "z": z, "from": p_ref, "to": p_now})
        if mode != "continuous":
            active = {sid: a for sid, a in active.items() if a["until"] > i}
            snapshot = [{**by_id[sid], "price": a["price"], "changes": {"bt": a["delta"]}} for sid, a in active.items()]

        rows = engine.reweight(holdings, snapshot, window="bt", sensitivity=sensitivity)
        w = {r["symbol"]: r["weight_pct"] / 100 for r in rows}
        base = {r["symbol"]: r["base_pct"] / 100 for r in rows}
        for s in symbols:
            weight_hist[s].append(w[s])

        turnover = sum(abs(w[s] - prev[s]) for s in symbols) / 2 if prev else 0.0
        turnovers.append(turnover)
        if prev and turnover > 0:
            mover = max(rows, key=lambda r: abs(w[r["symbol"]] - prev[r["symbol"]]))
            top = mover["contributions"][0] if mover["contributions"] else None
            moments.append({
                "date": today.isoformat(),
                "turnover": turnover,
                "symbol": mover["symbol"],
                "from_pct": 100 * prev[mover["symbol"]],
                "to_pct": 100 * w[mover["symbol"]],
                "signal": top["signal"] if top else None,
                "signal_label": by_id[top["signal"]]["label"] if top else None,
                "odds": next((x["price"] for x in snapshot if top and x["id"] == top["signal"]), None),
            })
        prev = w

        r = {s: closes[s][tomorrow] / closes[s][today] - 1 for s in symbols}
        dyn_r = sum(w[s] * r[s] for s in symbols) - turnover * cost_bps / 10_000
        static_r = sum(base[s] * r[s] for s in symbols)
        dyn_value *= 1 + dyn_r
        static_value *= 1 + static_r
        dyn_returns.append(dyn_r)
        static_returns.append(static_r)
        out_dates.append(tomorrow.isoformat())
        dyn_curve.append(dyn_value)
        static_curve.append(static_value)

    moments.sort(key=lambda m: m["turnover"], reverse=True)
    half = len(dyn_returns) // 2
    return {
        "dates": out_dates,
        "dynamic": dyn_curve,
        "static": static_curve,
        # Weight held from each date in `dates[:-1]` to the next.
        "weights": weight_hist,
        "stats": {
            "dynamic": stats(dyn_returns, dyn_curve),
            "static": stats(static_returns, static_curve),
            "avg_daily_turnover": sum(turnovers) / len(turnovers),
            "days": len(dyn_returns),
            # Same stats on each half, to check a setting isn't just fitting one stretch.
            "halves": [
                {"dynamic": stats(dyn_returns[a:b], curve_of(dyn_returns[a:b])),
                 "static": stats(static_returns[a:b], curve_of(static_returns[a:b]))}
                for a, b in ((0, half), (half, len(dyn_returns)))
            ],
        },
        "moments": moments[:5],
        "spikes": spikes,
    }


def curve_of(returns: list[float]) -> list[float]:
    curve = [1.0]
    for r in returns:
        curve.append(curve[-1] * (1 + r))
    return curve


def stats(returns: list[float], curve: list[float]) -> dict[str, float]:
    n = len(returns)
    mean = sum(returns) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in returns) / (n - 1)) if n > 1 else 0.0
    peak, max_dd = curve[0], 0.0
    for v in curve:
        peak = max(peak, v)
        max_dd = min(max_dd, v / peak - 1)
    return {
        "total_return": curve[-1] / curve[0] - 1,
        "ann_vol": sd * math.sqrt(252),
        "sharpe": mean / sd * math.sqrt(252) if sd else 0.0,
        "max_drawdown": max_dd,
    }
