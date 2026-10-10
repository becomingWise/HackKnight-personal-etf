from datetime import date, timedelta

import pytest

from polyslice_api.betas import BetaModel, regress

START = date(2024, 1, 1)


def build(n_days, slope_before, slope_after, switch):
    """Stock X moves `slope` × odds change (market flat); the relationship flips on `switch`."""
    days = [START + timedelta(days=k) for k in range(n_days)]
    dps = [0.02 if k % 3 == 0 else -0.01 if k % 3 == 1 else 0.005 for k in range(n_days)]
    spy, x, px = {}, {}, 100.0
    for k, d in enumerate(days):
        spy[d] = 100.0
        if k:
            px *= 1 + (slope_before if d < switch else slope_after) * dps[k]
        x[d] = px
    rows = [{"date": d.isoformat(), "p": 0.5, "dp": dp if k else None, "contract": "C"} for k, (d, dp) in enumerate(zip(days, dps))]
    series = {"id": "s", "betas": {"X": -1.0}, "rows": rows}
    return series, {"SPY": spy, "X": x}


def test_regress_recovers_slope():
    slope, t = regress([(x, 0.3 * x + (0.001 if i % 2 else -0.001)) for i, x in enumerate([0.01, -0.02, 0.03, 0.0, -0.01, 0.02])])
    assert slope == pytest.approx(0.3, abs=0.05)
    assert t > 5


def test_walk_forward_ignores_data_from_the_fitted_month_onward():
    switch = date(2025, 3, 1)
    series, closes = build(850, slope_before=0.1, slope_after=-0.1, switch=switch)
    model = BetaModel([series], closes, ["X"], prior="none", window_days=365, min_obs=60)
    # Fitted on data before March 1: only the old +0.1 slope -> β ≈ +1.0.
    assert model.at("s", date(2025, 3, 20))["X"] == pytest.approx(1.0, abs=0.05)
    # A year later the window holds only the flipped relationship.
    assert model.at("s", date(2026, 4, 5))["X"] == pytest.approx(-1.0, abs=0.05)


def test_too_little_data_falls_back_to_prior():
    series, closes = build(30, 0.1, 0.1, date(2030, 1, 1))
    blend = BetaModel([series], closes, ["X"], prior="blend", min_obs=120)
    assert blend.at("s", date(2024, 1, 25)) == {"X": -1.0}
    assert BetaModel([series], closes, ["X"], prior="none", min_obs=120).at("s", date(2024, 1, 25)) == {}
