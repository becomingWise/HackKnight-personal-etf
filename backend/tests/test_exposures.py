import numpy as np
import pytest

from polyslice_api.exposures import MAX_BETA, SCALE, benjamini_hochberg, fit_window

rng = np.random.default_rng(0)


def simulate(true_slopes, n=400, noise=0.01):
    x = rng.normal(0, 0.02, n)
    Y = np.column_stack([s * x + rng.normal(0, noise, n) for s in true_slopes])
    return x, Y


def test_recovers_a_clear_industry_effect_and_shrinks_noise_toward_zero():
    # Industry A truly moves 0.1 per unit odds change (β 1.0); industry B has no exposure.
    slopes = [0.1] * 6 + [0.0] * 6
    groups = np.array(["A"] * 6 + ["B"] * 6)
    x, Y = simulate(slopes)
    pooled, raw, se, n = fit_window(x, Y, groups, min_obs=100)
    assert np.all(np.abs(pooled[:6] - 0.1 * SCALE) < 0.3)
    assert np.all(np.abs(pooled[6:]) < np.abs(raw[6:]) + 1e-9)  # pulled toward zero
    assert np.all(np.abs(pooled) <= MAX_BETA)


def test_missing_values_and_short_histories():
    x, Y = simulate([0.1] * 12)
    Y[:, 0] = np.nan          # no data
    Y[:350, 1] = np.nan       # only 50 obs, below min_obs
    pooled, raw, se, n = fit_window(x, Y, np.array(["A"] * 12), min_obs=100)
    assert np.isnan(pooled[0]) and np.isnan(pooled[1])
    assert n[1] == 50
    assert np.all(np.isfinite(pooled[2:]))


def test_benjamini_hochberg():
    p = np.array([0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216])
    assert benjamini_hochberg(p, q=0.05).tolist() == [True, True] + [False] * 8
    assert benjamini_hochberg(np.array([0.5, 0.9]), q=0.1).sum() == 0
