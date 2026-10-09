from datetime import date, timedelta

import pytest

from polyslice_api import eventstudy

D0 = date(2025, 1, 6)  # a Monday


def series(dps, volume=5e6, first=D0 - timedelta(days=60)):
    rows = [{"date": (D0 + timedelta(days=k)).isoformat(), "p": 0.5, "dp": dp, "contract": "C"}
            for k, dp in enumerate(dps)]
    return {"id": "s", "betas": {"UP": 1.0, "DOWN": -1.0},
            "contracts": [{"event": "C", "first": first.isoformat(), "volume": volume}], "rows": rows}


def noise(n):
    return [0.01 if k % 2 else -0.01 for k in range(n)]


def test_find_spikes_needs_size_volume_and_cooldown():
    s = series(noise(30) + [0.10, 0.10] + noise(10))
    spikes = eventstudy.find_spikes(s, z_threshold=2.5, min_move=0.03, vol_window=30, cooldown=3)
    assert [sp["date"] for sp in spikes] == [(D0 + timedelta(days=30)).isoformat()]  # second day is in cooldown
    assert eventstudy.find_spikes(series(noise(30) + [0.10], volume=1e3), vol_window=30) == []


def test_event_scores_sign_by_odds_direction_and_beta():
    days = [D0 + timedelta(days=k) for k in range(5)]
    flat = {d: 100.0 for d in days}
    # Day 2: UP +2%, DOWN -2%, market flat.
    up = {**flat, days[2]: 102.0, days[3]: 102.0, days[4]: 102.0}
    down = {**flat, days[2]: 98.0, days[3]: 98.0, days[4]: 98.0}
    closes = {"SPY": flat, "UP": up, "DOWN": down}
    spike = {"series": "s", "date": days[2].isoformat(), "dp": 0.2}
    [ev] = eventstudy.event_scores([spike], {"s": {"UP": 1.0, "DOWN": -1.0}}, closes)
    assert ev["scores"]["day 0"] == pytest.approx(0.02)
    # Odds falling instead flips the prediction.
    [ev] = eventstudy.event_scores([{**spike, "dp": -0.2}], {"s": {"UP": 1.0, "DOWN": -1.0}}, closes)
    assert ev["scores"]["day 0"] == pytest.approx(-0.02)


def test_weekend_spike_anchors_to_next_trading_day():
    cal = [D0, D0 + timedelta(days=7)]  # Monday, next Monday
    assert eventstudy._anchor(cal, D0 + timedelta(days=5)) == 1


def test_summary_counts_one_score_per_date():
    events = [
        {"trading_day": "2025-01-06", "scores": {"day 0": 0.02}},
        {"trading_day": "2025-01-06", "scores": {"day 0": 0.00}},
        {"trading_day": "2025-01-07", "scores": {"day 0": -0.01}},
    ]
    [row] = [r for r in eventstudy.summarize(events) if r["window"] == "day 0"]
    assert row["dates"] == 2
    assert row["mean_bp"] == pytest.approx((0.01 - 0.01) / 2 * 10_000)
