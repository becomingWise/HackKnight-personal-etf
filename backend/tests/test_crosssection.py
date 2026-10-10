from datetime import date, timedelta

import numpy as np
import pandas as pd
import pytest

from polyslice_api import crosssection
from polyslice_api.exposures import SCALE

D0 = date(2025, 1, 6)  # a Monday
rng = np.random.default_rng(0)


def test_date_stats_recovers_slope_and_quintile_spread():
    pred = np.linspace(-0.01, 0.01, 100)
    ar = 0.5 * pred
    s = crosssection.date_stats(pred, ar)
    assert s["slope"] == pytest.approx(0.5)
    assert s["spread"] == pytest.approx(0.5 * (pred[-20:].mean() - pred[:20].mean()))
    assert s["stocks"] == 100


def test_date_stats_skips_missing_and_too_few_stocks():
    pred = np.linspace(-1, 1, 100)
    ar = pred.copy()
    ar[:60] = np.nan
    assert crosssection.date_stats(pred, ar) is None  # 40 < MIN_STOCKS
    assert crosssection.date_stats(np.zeros(100), pred) is None  # no spread in predictions


def frame(rows):
    days = [D0 + timedelta(days=k) for k in range(len(rows))]
    return pd.DataFrame(rows, index=days)


def test_score_combines_same_day_spikes_and_anchors_weekends():
    n = 60
    beta_a, beta_b = rng.normal(0, 1, n), rng.normal(0, 1, n)
    # Day 0 (Monday): stocks move by exactly the combined prediction of both spikes.
    day0 = (beta_a * 0.05 + beta_b * -0.04) / SCALE
    ar = frame([day0, np.zeros(n)])
    ar.index = [D0, D0 + timedelta(days=1)]
    xs = crosssection.CrossSection(ar, lambda sid, d: {"a": beta_a, "b": beta_b}[sid])
    spikes = [
        {"series": "a", "date": (D0 - timedelta(days=1)).isoformat(), "dp": 0.05, "volume": 5e6},  # Sunday
        {"series": "b", "date": D0.isoformat(), "dp": -0.04, "volume": 1e6},
    ]
    [row] = xs.score(spikes, volume_median=2e6)
    assert row["trading_day"] == D0.isoformat() and row["spikes"] == 2
    assert row["slope"] == pytest.approx(1.0)
    assert row["volume"] == "mixed"


def test_score_labels_volume_groups_and_flips_with_odds_direction():
    n = 60
    beta = rng.normal(0, 1, n)
    ar = frame([beta / SCALE * 0.05, -beta / SCALE * 0.05])
    xs = crosssection.CrossSection(ar, lambda sid, d: beta)
    rows = xs.score([
        {"series": "a", "date": D0.isoformat(), "dp": 0.05, "volume": 5e6},
        {"series": "a", "date": (D0 + timedelta(days=1)).isoformat(), "dp": -0.05, "volume": 1e6},
    ], volume_median=2e6)
    assert [r["volume"] for r in rows] == ["high", "low"]
    assert [r["slope"] for r in rows] == pytest.approx([1.0, 1.0])


def test_summary_tests_and_placebo():
    rows = [{"slope": s, "spread": 0.001 * s, "volume": v}
            for s, v in [(1.0, "high"), (1.2, "high"), (0.2, "low"), (0.4, "low"), (0.5, "mixed")]]
    s = crosssection.summarize(rows, placebo=[[{"slope": 0.0, "spread": 0.0, "volume": "high"}]])
    a, c = s["tests"]["H2a"], s["tests"]["H2c"]
    assert a["value"] == pytest.approx(0.66) and a["dates"] == 5
    assert c["value"] == pytest.approx(0.8) and c["high"] == 2 and c["low"] == 2 and c["mixed_excluded"] == 1
    assert c["t"] == pytest.approx(0.8 / np.sqrt(0.02 / 2 + 0.02 / 2))
    assert a["placebo_p"] == pytest.approx(0.5)
    assert "placebo_p" not in c  # the placebo run had no low-volume dates, so no H2c statistic
