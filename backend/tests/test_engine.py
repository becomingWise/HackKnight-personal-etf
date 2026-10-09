import pytest

from polyslice_api import engine

SECTORS = [
    {"id": "semis", "name": "Semis", "holdings": [
        {"symbol": "TSM", "name": "TSMC", "base": 60},
        {"symbol": "INTC", "name": "Intel", "base": 40},
    ]},
    {"id": "defense", "name": "Defense", "holdings": [
        {"symbol": "LMT", "name": "Lockheed", "base": 1},
    ]},
]


def signal(price, week_change, betas, id="taiwan"):
    return {"id": id, "label": id, "price": price, "changes": {"1w": week_change}, "betas": betas}


def by_symbol(rows):
    return {r["symbol"]: r for r in rows}


def test_scope_gives_each_sector_an_equal_share():
    rows = engine.scope_holdings(SECTORS, ["semis", "defense"])
    assert {r["symbol"]: r["base"] for r in rows} == pytest.approx({"TSM": 30, "INTC": 20, "LMT": 50})


def test_no_movement_keeps_base_weights():
    holdings = engine.scope_holdings(SECTORS, ["semis"])
    rows = by_symbol(engine.reweight(holdings, [signal(0.10, 0.0, {"TSM": -1.0, "INTC": 0.5})]))
    assert rows["TSM"]["weight_pct"] == pytest.approx(60)
    assert rows["INTC"]["change_pct"] == pytest.approx(0)


def test_rising_odds_tilt_by_beta_sign():
    holdings = engine.scope_holdings(SECTORS, ["semis"])
    # Odds rose 10 points this week; TSM is hurt, Intel helped.
    rows = by_symbol(engine.reweight(holdings, [signal(0.20, 0.10, {"TSM": -1.0, "INTC": 0.5})], sensitivity=2))
    assert rows["TSM"]["multiplier"] == pytest.approx(0.8)
    assert rows["INTC"]["multiplier"] == pytest.approx(1.1)
    # 60*0.8 = 48, 40*1.1 = 44 -> renormalized
    assert rows["TSM"]["weight_pct"] == pytest.approx(100 * 48 / 92)
    assert sum(r["weight_pct"] for r in rows.values()) == pytest.approx(100)


def test_what_if_override_replaces_live_odds():
    holdings = engine.scope_holdings(SECTORS, ["semis"])
    s = signal(0.10, 0.0, {"TSM": -1.0})
    rows = by_symbol(engine.reweight(holdings, [s], sensitivity=1, overrides={"taiwan": 0.60}))
    assert rows["TSM"]["multiplier"] == pytest.approx(0.5)
    assert rows["TSM"]["contributions"][0]["delta"] == pytest.approx(0.5)


def test_multiplier_is_clipped_and_all_zero_falls_back_to_base():
    holdings = engine.scope_holdings(SECTORS, ["semis"])
    s = signal(0.9, 0.0, {"TSM": -5.0, "INTC": -5.0})
    rows = by_symbol(engine.reweight(holdings, [s], overrides={"taiwan": 1.0}, sensitivity=10))
    assert rows["TSM"]["multiplier"] == 0
    assert rows["TSM"]["weight_pct"] == pytest.approx(60)


def test_unavailable_signal_is_ignored():
    holdings = engine.scope_holdings(SECTORS, ["semis"])
    s = {"id": "gone", "label": "gone", "price": None, "betas": {"TSM": -1.0}}
    rows = by_symbol(engine.reweight(holdings, [s]))
    assert rows["TSM"]["contributions"] == []


def test_suggestions_rank_out_of_scope_sectors_by_tilt():
    s = signal(0.30, 0.10, {"LMT": 0.6})
    out = engine.expansion_suggestions(SECTORS, ["semis"], [s], sensitivity=2)
    assert [o["sector"] for o in out] == ["defense"]
    assert out[0]["score"] == pytest.approx(2 * 0.6 * 0.10)
    assert out[0]["driver"] == "taiwan"
    assert engine.expansion_suggestions(SECTORS, ["semis", "defense"], [s]) == []


def test_ticket_cents_add_up_exactly():
    rows = [
        {"symbol": "A", "name": "A", "weight_pct": 100 / 3},
        {"symbol": "B", "name": "B", "weight_pct": 100 / 3},
        {"symbol": "C", "name": "C", "weight_pct": 100 / 3},
    ]
    lines = engine.trade_ticket(rows, 100.0, {"A": 50.0})
    assert round(sum(l["dollars"] for l in lines), 2) == 100.0
    assert lines[0]["units"] == pytest.approx(lines[0]["dollars"] / 50)
    assert lines[1]["units"] is None
