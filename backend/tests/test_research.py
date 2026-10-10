from datetime import date, timedelta

import pytest

from polyslice_api import research

CAL = [date(2025, 1, 1) + timedelta(days=k) for k in range(100)]


def test_clusters_link_dates_within_the_gap():
    days = [CAL[0], CAL[3], CAL[8], CAL[20], CAL[24]]
    assert research.clusters(days, CAL, gap=5) == [[CAL[0], CAL[3], CAL[8]], [CAL[20], CAL[24]]]


def test_drop_largest_cluster_removes_the_cluster_driving_the_mean():
    scores = {CAL[0]: 0.01, CAL[10]: 0.02, CAL[30]: 0.10, CAL[32]: 0.05, CAL[60]: -0.01, CAL[80]: 0.01}
    out = research.drop_largest_cluster(scores, CAL, window=5)
    assert out["dropped"] == [CAL[30].isoformat(), CAL[32].isoformat()]
    assert out["dates"] == 4
    assert out["mean"] == pytest.approx(0.0075)
    assert out["t"] == pytest.approx(research.t_stat([0.01, 0.02, -0.01, 0.01]))


def test_drop_largest_cluster_follows_the_sign_and_window():
    # A negative statistic loses its most negative cluster; a 10-day window merges more dates.
    scores = {CAL[0]: -0.05, CAL[8]: -0.04, CAL[40]: -0.01, CAL[70]: 0.01}
    assert research.drop_largest_cluster(scores, CAL, window=5)["dropped"] == [CAL[0].isoformat()]
    assert research.drop_largest_cluster(scores, CAL, window=10)["dropped"] == [CAL[0].isoformat(), CAL[8].isoformat()]


def test_robust_verdict_downgrades_when_reduced_t_misses_the_bar():
    assert research.robust_verdict(3.5, 3.2) == ("evidence", "evidence")
    assert research.robust_verdict(2.41, 1.95) == ("suggestive", "not supported")
    assert research.robust_verdict(3.5, 2.5) == ("evidence", "suggestive")
    assert research.robust_verdict(-1.0, -0.5) == ("not supported", "not supported")
