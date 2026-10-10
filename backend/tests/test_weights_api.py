import importlib

import pytest
from fastapi.testclient import TestClient

# `polyslice_api.main` the attribute is the CLI entry function; we want the module.
main = importlib.import_module("polyslice_api.main")

LIVE = [
    {"id": "taiwan", "label": "China invades Taiwan", "status": "live", "price": 0.30,
     "question": "Will China invade Taiwan by December 31, 2027?", "url": "https://polymarket.com/event/taiwan",
     "changes": {"1w": 0.10}, "betas": {"TSM": -1.0, "INTC": 0.5}},
    {"id": "gone", "label": "Closed", "status": "unavailable", "price": None, "betas": {"TSM": 1.0}},
]


@pytest.fixture
def client(monkeypatch):
    async def fake_signals(_config):
        return LIVE
    monkeypatch.setattr(main.polymarket, "signals", fake_signals)
    return TestClient(main.app)


def post(client, holdings):
    return client.post("/api/weights", json={"idea": "chips", "holdings": holdings})


def test_adjusts_known_symbols_and_keeps_contract(client):
    body = post(client, [{"symbol": "TSM", "weightPct": 50}, {"symbol": "INTC", "weightPct": 30},
                         {"symbol": "SOLAR_DEMO", "weightPct": 20}]).json()
    assert body["status"] == "adjusted"
    assert [h["symbol"] for h in body["holdings"]] == ["TSM", "INTC", "SOLAR_DEMO"]
    assert round(sum(h["weightPct"] for h in body["holdings"]), 2) == 100.0
    weights = {h["symbol"]: h["weightPct"] for h in body["holdings"]}
    assert weights["TSM"] < 50 and weights["INTC"] > 30
    [ev] = body["evidence"]  # the unavailable market is never cited
    assert ev["url"].startswith("https://") and 0 <= ev["probability"] <= 1 and ev["outcome"] == "Yes"
    assert "TSM" in body["explanation"]


def test_unrelated_symbols_return_input_weights_verbatim(client):
    holdings = [{"symbol": "SOLAR_DEMO", "weightPct": 33.33}, {"symbol": "TIDAL_DEMO", "weightPct": 33.33},
                {"symbol": "GRID_DEMO", "weightPct": 33.34}]
    body = post(client, holdings).json()
    assert body["status"] == "unchanged"
    assert body["holdings"] == holdings
    assert body["evidence"] == []


def test_lowercase_symbols_match_but_are_echoed_as_given(client):
    body = post(client, [{"symbol": "tsm", "weightPct": 50}, {"symbol": "intc", "weightPct": 50}]).json()
    assert [h["symbol"] for h in body["holdings"]] == ["tsm", "intc"]


def test_rejects_bad_input(client):
    assert post(client, [{"symbol": "TSM", "weightPct": 60}, {"symbol": "TSM", "weightPct": 40}]).status_code == 422
    assert post(client, [{"symbol": "TSM", "weightPct": 60}]).status_code == 422
