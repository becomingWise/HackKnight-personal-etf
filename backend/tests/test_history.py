from datetime import date, timedelta

import pytest

from polyslice_api import backtest, history

D0 = date(2025, 1, 1)


def contract(name, end_offset, prices):
    return {"event": name, "end": D0 + timedelta(days=end_offset),
            "prices": {D0 + timedelta(days=k): p for k, p in prices.items()}}


def test_chain_rolls_to_next_contract_and_breaks_the_change():
    jan = contract("Jan", 3, {0: 0.10, 1: 0.20, 2: 0.30, 3: 1.0})
    mar = contract("Mar", 60, {0: 0.50, 1: 0.55, 2: 0.60, 3: 0.40, 4: 0.45})
    rows = history.chain([jan, mar], min_days_to_expiry=2, until=D0 + timedelta(days=4))
    assert [r["contract"] for r in rows] == ["Jan", "Jan", "Mar", "Mar", "Mar"]
    assert rows[1]["dp"] == pytest.approx(0.10)
    assert rows[2]["dp"] is None  # roll day: Jan 0.20 -> Mar 0.60 is not a move
    assert rows[3]["dp"] == pytest.approx(-0.20)


def test_as_history_reproduces_chained_moves_anchored_to_latest_price():
    jan = contract("Jan", 3, {0: 0.10, 1: 0.20})
    mar = contract("Mar", 60, {2: 0.60, 3: 0.40})
    series = {"rows": history.chain([jan, mar], 2, until=D0 + timedelta(days=3))}
    path = history.as_history(series)
    assert path[-1]["p"] == pytest.approx(0.40)
    moves = [b["p"] - a["p"] for a, b in zip(path, path[1:])]
    assert moves == pytest.approx([0.10, 0.0, -0.20])
    assert backtest.odds_at(path, path[-1]["t"]) == pytest.approx(0.40)
