from datetime import date, timedelta

import numpy as np
import pytest

from polyslice_api import backtest, engine, mechanism
from polyslice_api.mechanism import Basket, Config, Replay

CAL = [date(2025, 1, 6) + timedelta(days=k) for k in range(300)]


def test_weights_match_engine_reweight():
    betas = np.array([[1.2, -0.5, 0.0, 0.3]])
    w = mechanism.weights(betas, np.array([0.08]), 2.0)
    holdings = [{"symbol": s, "name": s, "base": 25.0} for s in "ABCD"]
    signal = {"id": "x", "price": 0.5, "changes": {"bt": 0.08}, "betas": dict(zip("ABCD", betas[0]))}
    rows = engine.reweight(holdings, [signal], window="bt", sensitivity=2.0)
    assert w[0] == pytest.approx([r["weight_pct"] / 100 for r in rows])


def test_retrigger_replaces_delta_and_restarts_hold_like_the_backtest():
    path = mechanism.tilt_path([(2, 0.05), (4, -0.03)], hold=3, days=10)
    assert list(path) == [0, 0, 0.05, 0.05, -0.03, -0.03, -0.03, 0, 0, 0]
    # Day 4's tilt covers days 4-6: a trigger on day 6 extends the episode, day 9 starts a new one.
    eps = mechanism.episodes([(2, 0.05), (4, -0.03), (6, 0.1), (9, 0.2)], hold=3)
    assert eps == [[(2, 0.05), (4, -0.03), (6, 0.1)], [(9, 0.2)]]


def test_triggers_match_backtest_spikes():
    rng = np.random.default_rng(1)
    days = CAL[:120]
    p = np.clip(0.4 + np.cumsum(rng.normal(0, 0.01, len(days))), 0.01, 0.99)
    p[80] += 0.15
    history = [{"t": backtest.close_ts(d), "p": float(x)} for d, x in zip(days, p)]
    cfg = Config("A", 1, 2.5, 5, 2.0)
    fired = mechanism.triggers(history, days, cfg)
    holdings = [{"symbol": "X", "name": "X", "base": 100.0}]
    sim = backtest.simulate(holdings, [{"id": "s", "label": "s", "betas": {"X": 1.0}}], {"s": history},
                            {"X": {d: 100.0 for d in days}}, mode="spike", lookback_days=1, z_threshold=2.5, hold_days=5)
    # simulate stops one day early (it needs a next close).
    assert [days[i].isoformat() for i, _ in fired if i < len(days) - 1] == [s["date"] for s in sim["spikes"]]
    assert any(i == 80 for i, _ in fired)


def test_max_drawdown():
    assert mechanism.max_drawdown(np.array([0.1, -0.5, 0.2])) == pytest.approx(-0.5)
    assert mechanism.max_drawdown(np.array([0.01, 0.02])) == 0.0


def synthetic(effect: float, seed: int = 0):
    """20-stock basket; after each planted trigger, stocks fall in proportion to −β × Δp × effect."""
    rng = np.random.default_rng(seed)
    T, N = len(CAL), 20
    betas = np.tile(np.linspace(-1, 1, N), (T, 1))
    basket = Basket("s", np.tile(np.arange(N), (T, 1)), betas, np.ones(T, bool))
    R = rng.normal(0, 0.01, (T, N))
    firings = [(i, 0.1 if k % 2 else -0.1) for k, i in enumerate(range(20, T - 20, 25))]
    for i, dp in firings:
        R[i:i + 5] += -effect * np.abs(betas[0] * dp) * (betas[0] * dp < 0)
    return Replay(basket, R, cost_bps=0), firings


def test_run_config_detects_a_planted_drawdown_cut_and_not_a_null():
    cfg = Config("A", 1, 2.5, 5, 2.0)
    rp, firings = synthetic(effect=0.05)
    out = mechanism.run_config(cfg, {"s": rp}, {"s": firings}, {"s": np.ones(len(CAL), bool)}, CAL, placebo=50)
    assert out["mean_bp"] > 0 and out["t"] > 3 and out["placebo_p"] < 0.05
    assert out["robust"]["t"] > 3 and out["robust_verdict"] == "evidence"

    rp, firings = synthetic(effect=0.0)
    out = mechanism.run_config(cfg, {"s": rp}, {"s": firings}, {"s": np.ones(len(CAL), bool)}, CAL, placebo=50)
    assert abs(out["t"]) < 3


def test_episodes_need_an_eligible_window():
    cfg = Config("A", 1, 2.5, 5, 2.0)
    rp, firings = synthetic(effect=0.05)
    eligible = np.array([d < CAL[150] for d in CAL])
    out = mechanism.run_config(cfg, {"s": rp}, {"s": firings}, {"s": eligible}, CAL, placebo=0)
    assert out["episodes"] == sum(1 for i, _ in firings if i + mechanism.WINDOW <= 150)
