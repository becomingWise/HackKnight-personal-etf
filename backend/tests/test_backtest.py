from datetime import date

import pytest

from polyslice_api import backtest

HOLDINGS = [
    {"symbol": "TSM", "name": "TSMC", "base": 50.0, "sector": "semis"},
    {"symbol": "INTC", "name": "Intel", "base": 50.0, "sector": "semis"},
]
SIGNAL = {"id": "taiwan", "label": "China invades Taiwan", "betas": {"TSM": -1.0, "INTC": 1.0}}
D = [date(2026, 3, 2), date(2026, 3, 3), date(2026, 3, 4)]


def odds(points):
    """[(date, p)] -> CLOB-style history printed at each day's close."""
    return [{"t": backtest.close_ts(d), "p": p} for d, p in points]


def test_odds_at_uses_last_print_at_or_before():
    h = odds([(D[0], 0.1), (D[1], 0.3)])
    assert backtest.odds_at(h, backtest.close_ts(D[0]) - 1) is None
    assert backtest.odds_at(h, backtest.close_ts(D[0])) == 0.1
    assert backtest.odds_at(h, backtest.close_ts(D[2])) == 0.3


def test_flat_odds_match_static_basket():
    closes = {"TSM": dict(zip(D, [100, 110, 121])), "INTC": dict(zip(D, [100, 100, 100]))}
    flat = odds([(date(2026, 2, 1), 0.2)])
    out = backtest.simulate(HOLDINGS, [SIGNAL], {"taiwan": flat}, closes, cost_bps=0)
    assert out["dynamic"] == pytest.approx(out["static"])
    assert out["static"][-1] == pytest.approx(1.05 * 1.05)


def test_rising_odds_shift_weight_before_the_move():
    # Odds jump on day 0; TSM then falls 10%, Intel rises 10%.
    closes = {"TSM": dict(zip(D, [100, 90, 90])), "INTC": dict(zip(D, [100, 110, 110]))}
    h = odds([(date(2026, 2, 20), 0.1), (D[0], 0.35)])
    out = backtest.simulate(HOLDINGS, [SIGNAL], {"taiwan": h}, closes, lookback_days=7, sensitivity=2, cost_bps=0)
    # Day 0 weights: TSM 50*0.5, INTC 50*1.5 -> 25% / 75%.
    assert out["weights"]["TSM"][0] == pytest.approx(0.25)
    assert out["dynamic"][1] == pytest.approx(1 + 0.25 * -0.10 + 0.75 * 0.10)
    assert out["static"][1] == pytest.approx(1.0)
    assert out["stats"]["dynamic"]["total_return"] > out["stats"]["static"]["total_return"]


def test_trading_costs_charge_turnover():
    closes = {"TSM": dict(zip(D, [100, 100, 100])), "INTC": dict(zip(D, [100, 100, 100]))}
    # Odds flat on day 0, jump before day 1 -> weights change once.
    h = odds([(date(2026, 2, 1), 0.1), (D[1], 0.35)])
    out = backtest.simulate(HOLDINGS, [SIGNAL], {"taiwan": h}, closes, sensitivity=2, cost_bps=10)
    assert out["stats"]["avg_daily_turnover"] == pytest.approx(0.25 / 2)
    assert out["dynamic"][-1] == pytest.approx(1 - 0.25 * 0.001)
    assert out["moments"][0]["symbol"] in {"TSM", "INTC"}


def test_missing_prices_return_empty():
    out = backtest.simulate(HOLDINGS, [SIGNAL], {}, {"TSM": {D[0]: 1.0}})
    assert out["stats"] is None


def daily(points_from, values):
    """Odds printed at each calendar day's close starting `points_from`."""
    from datetime import timedelta
    return [{"t": backtest.close_ts(points_from + timedelta(days=k)), "p": p} for k, p in enumerate(values)]


def test_spike_z_scales_by_prior_noise():
    start = date(2026, 1, 1)
    calm = [0.20 + (0.01 if k % 2 else 0) for k in range(40)] + [0.40]  # ±1pt noise, then +20pt jump
    h = daily(start, calm)
    now = h[-1]["t"]
    z = backtest.spike_z(h, now, lookback_days=1, vol_window=30)
    assert z > 10
    # The same jump in a market that already swings ±20pts a day is not a spike.
    wild = [0.20 + (0.20 if k % 2 else 0) for k in range(40)] + [0.60]
    assert abs(backtest.spike_z(daily(start, wild), now, lookback_days=1, vol_window=30)) < 2


def test_spike_mode_tilts_only_on_spikes_and_reverts():
    from datetime import timedelta
    days = [date(2026, 3, 2) + timedelta(days=k) for k in range(6)]
    closes = {"TSM": {d: 100.0 for d in days}, "INTC": {d: 100.0 for d in days}}
    # Flat for 40 days, jump on days[1], flat after.
    start = days[1] - timedelta(days=40)
    h = daily(start, [0.10] * 40 + [0.40] * 10)
    out = backtest.simulate(HOLDINGS, [SIGNAL], {"taiwan": h}, closes, mode="spike",
                            lookback_days=1, z_threshold=3, hold_days=2, sensitivity=1, cost_bps=0)
    tsm = out["weights"]["TSM"]
    assert tsm[0] == pytest.approx(0.5)          # before the spike: base
    assert tsm[1] < 0.5 and tsm[2] == tsm[1]     # tilted on the spike, held
    assert tsm[3] == pytest.approx(0.5)          # reverted after hold_days
    assert [s["date"] for s in out["spikes"]] == [days[1].isoformat()]
    assert len(out["stats"]["halves"]) == 2
