"""Research periods. See research/PREREGISTRATION.md.

Everything up to HOLDOUT_START is the development period: estimate, explore and
choose configurations there. The holdout is evaluated once, at the end.
"""

from __future__ import annotations

from datetime import date
from typing import Literal

HOLDOUT_START = date(2026, 4, 10)

Period = Literal["dev", "holdout", "all"]


def in_period(d: date | str, period: Period) -> bool:
    d = date.fromisoformat(d) if isinstance(d, str) else d
    if period == "dev":
        return d < HOLDOUT_START
    if period == "holdout":
        return d >= HOLDOUT_START
    return True


EVIDENCE_T, SUGGESTIVE_T = 3.0, 2.0
MIN_CLUSTER_GAP = 5


def t_stat(xs: list[float]) -> float:
    n = len(xs)
    if n < 2:
        return 0.0
    mean = sum(xs) / n
    sd = (sum((x - mean) ** 2 for x in xs) / (n - 1)) ** 0.5
    return mean / (sd / n**0.5) if sd else 0.0


def verdict(t: float) -> str:
    return "evidence" if t > EVIDENCE_T else "suggestive" if t > SUGGESTIVE_T else "not supported"


def clusters(days: list[date], calendar: list[date], gap: int) -> list[list[date]]:
    """Single-linkage groups: a date joins the previous one's cluster if within `gap` trading days."""
    pos = {d: i for i, d in enumerate(calendar)}
    out: list[list[date]] = []
    for d in sorted(days):
        if out and pos[d] - pos[out[-1][-1]] <= gap:
            out[-1].append(d)
        else:
            out.append([d])
    return out


def drop_largest_cluster(scores: dict[date, float], calendar: list[date], window: int) -> dict:
    """Amendment 17: rerun the date-level t-test without the cluster that pushes hardest toward the result."""
    sign = 1.0 if sum(scores.values()) >= 0 else -1.0
    groups = clusters(list(scores), calendar, max(MIN_CLUSTER_GAP, window))
    worst = max(groups, key=lambda g: sign * sum(scores[d] for d in g)) if groups else []
    rest = [v for d, v in sorted(scores.items()) if d not in set(worst)]
    return {
        "dropped": [d.isoformat() for d in worst],
        "dates": len(rest),
        "mean": sum(rest) / len(rest) if rest else float("nan"),
        "t": t_stat(rest),
    }


def robust_verdict(t_full: float, t_reduced: float) -> tuple[str, str]:
    """(verdict on all dates, verdict after the cluster rule): it keeps a bar only if the reduced t clears it too."""
    full = verdict(t_full)
    return full, verdict(min(t_full, t_reduced))
