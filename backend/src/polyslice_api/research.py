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
