"""Event study: do Polymarket odds spikes predict the stocks they're supposed to move?

For each spike in a chained odds series we look at every stock with a β to that
series and compute its market-adjusted return (stock minus SPY) in windows
around the spike. Each return is signed by sign(odds move) × sign(β), so a
positive number means "moved the way the β predicted". Stocks are averaged
(|β|-weighted) into one score per event, events on the same date are averaged
into one score per date (so a single news day can't count twice), and dates
are tested with a t-test, a hit rate with a binomial test, and a placebo that
reruns everything on random dates.

Timing: odds are sampled at the US close (20:00 UTC), so a spike on trading day
d is the odds change from close d-1 to close d, the same span as the stocks' day 0.
Day 0 therefore measures the simultaneous reaction, and windows from day +1 on
are tradable (enter at close d, once the spike is visible). A spike on a weekend
or holiday is matched to the next trading day.

Run `uv run python -m polyslice_api.eventstudy` for a report.
"""

from __future__ import annotations

import bisect
import math
import random
from datetime import date
from typing import Any

# (label, first day, last day) relative to the spike date's trading day index.
WINDOWS = [
    ("pre  -5..-1", -5, -1),
    ("day 0", 0, 0),
    ("day +1", 1, 1),
    ("post +1..+5", 1, 5),
    ("post +1..+10", 1, 10),
]


def find_spikes(
    series: dict[str, Any],
    *,
    z_threshold: float = 2.5,
    min_move: float = 0.03,
    vol_window: int = 30,
    min_volume: float = 1_000_000,
    min_contract_age: int = 7,
    cooldown: int = 3,
) -> list[dict[str, Any]]:
    """Days whose odds change is large vs. the prior `vol_window` changes.

    Skips thin contracts (`min_volume` lifetime dollars) and each contract's first
    `min_contract_age` days, where a handful of trades can fake a spike. After a
    spike, the next `cooldown` days can't start a new one, so one story counts once.
    """
    meta = {c["event"]: c for c in series["contracts"]}
    history: list[float] = []
    out: list[dict[str, Any]] = []
    last_spike: date | None = None
    for row in series["rows"]:
        dp = row["dp"]
        if dp is None:
            continue
        day = date.fromisoformat(row["date"])
        c = meta[row["contract"]]
        if len(history) >= vol_window:
            window = history[-vol_window:]
            mean = sum(window) / len(window)
            sd = max(math.sqrt(sum((x - mean) ** 2 for x in window) / (len(window) - 1)), 0.005)
            z = dp / sd
            age = (day - date.fromisoformat(c["first"])).days
            if (
                abs(z) >= z_threshold
                and abs(dp) >= min_move
                and c["volume"] >= min_volume
                and age >= min_contract_age
                and (last_spike is None or (day - last_spike).days > cooldown)
            ):
                out.append({"series": series["id"], "date": row["date"], "dp": dp, "p": row["p"], "z": z,
                            "contract": row["contract"]})
                last_spike = day
        history.append(dp)
    return out


def _anchor(calendar: list[date], d: date) -> int | None:
    """Index of the first trading day on or after `d` (when stocks can first react)."""
    i = bisect.bisect_left(calendar, d)
    return i if i < len(calendar) else None


def window_return(closes: dict[date, float], calendar: list[date], i0: int, a: int, b: int) -> float | None:
    """Compound return from the close before day i0+a to the close of day i0+b."""
    lo, hi = i0 + a - 1, i0 + b
    if lo < 0 or hi >= len(calendar):
        return None
    start, end = closes.get(calendar[lo]), closes.get(calendar[hi])
    return end / start - 1 if start and end else None


def event_scores(
    spikes: list[dict[str, Any]],
    betas: dict[str, dict[str, float]],
    closes: dict[str, dict[date, float]],
    market: str = "SPY",
) -> list[dict[str, Any]]:
    """Signed, |β|-weighted market-adjusted return per event and window."""
    calendar = sorted(closes[market])
    out = []
    for spike in spikes:
        i0 = _anchor(calendar, date.fromisoformat(spike["date"]))
        if i0 is None:
            continue
        direction = 1.0 if spike["dp"] > 0 else -1.0
        scores = {}
        for label, a, b in WINDOWS:
            m = window_return(closes[market], calendar, i0, a, b)
            num = den = 0.0
            for symbol, beta in betas[spike["series"]].items():
                r = window_return(closes.get(symbol, {}), calendar, i0, a, b)
                if r is None or m is None:
                    continue
                num += abs(beta) * direction * math.copysign(1.0, beta) * (r - m)
                den += abs(beta)
            scores[label] = num / den if den else None
        out.append({**spike, "trading_day": calendar[i0].isoformat(), "scores": scores})
    return out


def _by_date(events: list[dict[str, Any]], label: str) -> list[float]:
    groups: dict[str, list[float]] = {}
    for e in events:
        s = e["scores"].get(label)
        if s is not None:
            groups.setdefault(e["trading_day"], []).append(s)
    return [sum(v) / len(v) for v in groups.values()]


def _t_stat(xs: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mean = sum(xs) / n
    sd = math.sqrt(sum((x - mean) ** 2 for x in xs) / (n - 1))
    return mean / (sd / math.sqrt(n)) if sd else 0.0


def _binom_p(hits: int, n: int) -> float:
    """Two-sided binomial test against a coin flip."""
    if n == 0:
        return 1.0
    k = max(hits, n - hits)
    tail = sum(math.comb(n, i) for i in range(k, n + 1)) / 2**n
    return min(1.0, 2 * tail)


def summarize(events: list[dict[str, Any]], placebo: list[list[dict[str, Any]]] | None = None) -> list[dict[str, Any]]:
    rows = []
    for label, _, _ in WINDOWS:
        xs = _by_date(events, label)
        if not xs:
            continue
        mean = sum(xs) / len(xs)
        hits = sum(1 for x in xs if x > 0)
        row = {
            "window": label,
            "dates": len(xs),
            "mean_bp": mean * 10_000,
            "t": _t_stat(xs),
            "hit_rate": hits / len(xs),
            "binom_p": _binom_p(hits, len(xs)),
        }
        if placebo:
            null = [sum(p) / len(p) for p in (_by_date(run, label) for run in placebo) if p]
            # Two-sided: how often random dates produce a mean at least this far from zero.
            row["placebo_p"] = (1 + sum(1 for x in null if abs(x) >= abs(mean))) / (1 + len(null))
        rows.append(row)
    return rows


def placebo_runs(
    spikes: list[dict[str, Any]],
    series_list: list[dict[str, Any]],
    betas: dict[str, dict[str, float]],
    closes: dict[str, dict[date, float]],
    runs: int = 500,
    seed: int = 7,
) -> list[list[dict[str, Any]]]:
    """Same spikes (series, direction) moved to random dates within each series' coverage."""
    rng = random.Random(seed)
    days = {s["id"]: [r["date"] for r in s["rows"] if r["dp"] is not None] for s in series_list}
    out = []
    for _ in range(runs):
        fake = [{**sp, "date": rng.choice(days[sp["series"]])} for sp in spikes]
        out.append(event_scores(fake, betas, closes))
    return out


def empirical_betas(
    series: dict[str, Any],
    closes: dict[str, dict[date, float]],
    market: str = "SPY",
    min_obs: int = 60,
) -> dict[str, dict[str, float]]:
    """Same-day regression of each stock's market-adjusted return on the odds change.

    Slope is % stock move per 100-point odds move; compare its sign with the hand-picked β.
    """
    calendar = sorted(closes[market])
    index = {d: i for i, d in enumerate(calendar)}
    out = {}
    for symbol, beta in series["betas"].items():
        xs, ys = [], []
        for row in series["rows"]:
            d = date.fromisoformat(row["date"])
            if row["dp"] is None or d not in index:
                continue
            i = index[d]
            r = window_return(closes.get(symbol, {}), calendar, i, 0, 0)
            m = window_return(closes[market], calendar, i, 0, 0)
            if r is not None and m is not None:
                xs.append(row["dp"])
                ys.append(r - m)
        n = len(xs)
        if n < min_obs:
            continue
        mx, my = sum(xs) / n, sum(ys) / n
        sxx = sum((x - mx) ** 2 for x in xs)
        if not sxx:
            continue
        slope = sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / sxx
        resid = [y - my - slope * (x - mx) for x, y in zip(xs, ys)]
        se = math.sqrt(sum(e * e for e in resid) / (n - 2) / sxx)
        out[symbol] = {"beta_guess": beta, "slope": slope, "t": slope / se if se else 0.0, "n": n}
    return out


async def run(placebo: int = 500, **spike_kwargs) -> dict[str, Any]:
    from . import history, prices

    series_list = await history.load_all()
    betas = {s["id"]: s["betas"] for s in series_list}
    symbols = sorted({sym for b in betas.values() for sym in b} | {"SPY"})
    start = min(s["rows"][0]["date"] for s in series_list if s["rows"])
    closes = await prices.daily_closes(symbols, start)

    spikes = [sp for s in series_list for sp in find_spikes(s, **spike_kwargs)]
    events = event_scores(spikes, betas, closes)
    nulls = placebo_runs(spikes, series_list, betas, closes, runs=placebo) if placebo else None
    return {
        "spikes": len(spikes),
        "by_series": {s["id"]: sum(1 for sp in spikes if sp["series"] == s["id"]) for s in series_list},
        "summary": summarize(events, nulls),
        "per_series": {
            s["id"]: summarize([e for e in events if e["series"] == s["id"]]) for s in series_list
        },
        "events": events,
        "empirical_betas": {s["id"]: empirical_betas(s, closes) for s in series_list},
    }


def _print(report: dict[str, Any]) -> None:
    def table(rows):
        print(f"    {'window':<14}{'dates':>6}{'mean':>9}{'t':>7}{'hit':>7}{'binom p':>9}{'placebo p':>11}")
        for r in rows:
            pp = f"{r['placebo_p']:.3f}" if "placebo_p" in r else ""
            print(f"    {r['window']:<14}{r['dates']:>6}{r['mean_bp']:>7.0f}bp{r['t']:>7.2f}"
                  f"{r['hit_rate']:>7.0%}{r['binom_p']:>9.3f}{pp:>11}")

    print(f"{report['spikes']} spikes: {report['by_series']}\n")
    print("All series (score > 0 = moved the way β predicted):")
    table(report["summary"])
    for sid, rows in report["per_series"].items():
        print(f"\n  {sid}")
        table(rows)
    print("\nEmpirical same-day sensitivity vs. guessed β (sign agreement):")
    for sid, rows in report["empirical_betas"].items():
        agree = [r for r in rows.values() if math.copysign(1, r["slope"]) == math.copysign(1, r["beta_guess"])]
        strong = {s: r for s, r in rows.items() if abs(r["t"]) >= 2}
        print(f"  {sid:<18} signs agree {len(agree)}/{len(rows)}; |t|≥2: " + ", ".join(
            f"{s} {r['slope'] * 100:+.0f}bp/pt (guess {r['beta_guess']:+.1f}, t {r['t']:.1f})"
            for s, r in sorted(strong.items(), key=lambda kv: -abs(kv[1]['t']))) or "none")


if __name__ == "__main__":
    import asyncio

    _print(asyncio.run(run()))
