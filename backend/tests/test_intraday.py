from datetime import date, datetime, timedelta, timezone

import numpy as np
import pandas as pd
import pytest

from polyslice_api import history, intraday

UTC = timezone.utc
T0 = datetime(2025, 1, 6, 15, 30, tzinfo=UTC)  # a Monday, EST: bars start 14:30, 15:30, ..., 20:30 UTC
T1 = T0 + timedelta(days=1)  # far enough from the start of `session_bars` for six bars before


def session_bars(days: int, first: date = date(2025, 1, 6), opens=(14, 30), n: int = 7) -> list[datetime]:
    out = []
    for k in range(days):
        d = first + timedelta(days=k)
        if d.weekday() < 5:
            o = datetime(d.year, d.month, d.day, *opens, tzinfo=UTC)
            out += [o + timedelta(hours=h) for h in range(n)]
    return out


def hourly_series(moves: dict[datetime, float], start: datetime, hours: int, volume=5e6):
    rows = []
    for k in range(hours):
        t = start + timedelta(hours=k)
        noise = 0.002 if k % 2 else -0.002
        rows.append({"t": t.isoformat(), "p": 0.5, "dp": moves.get(t, noise), "contract": "C"})
    return {"id": "s", "contracts": [{"event": "C", "volume": volume}], "rows": rows}


def test_hourly_spikes_need_size_session_cooldown_and_volume():
    start = T0 - timedelta(days=8)
    bars = set(session_bars(14, first=date(2024, 12, 29)))
    big = 0.05
    moves = {
        T0: big,                              # 14:30–15:30 UTC on a Monday: counts
        T0 + timedelta(hours=3): big,         # inside the 6-hour cooldown
        T0 + timedelta(hours=8): big,         # 23:30, after hours
        T0 + timedelta(days=1, hours=-1): big,  # 13:30–14:30, starts before the window
        T0 + timedelta(days=1, hours=2): 0.02,  # big z but under 3 pts
        T0 + timedelta(days=2): -big,         # counts, negative
    }
    s = hourly_series(moves, start, 24 * 12)
    spikes = intraday.find_hourly_spikes(s, bars)
    assert [(sp["t"], sp["dp"]) for sp in spikes] == [(T0.isoformat(), big), ((T0 + timedelta(days=2)).isoformat(), -big)]
    assert intraday.find_hourly_spikes(hourly_series(moves, start, 24 * 12, volume=1e3), bars) == []


def test_hourly_spikes_need_a_full_week_of_history_and_a_market_bar():
    bars = set(session_bars(3))
    s = hourly_series({T0: 0.05}, T0 - timedelta(hours=100), 120)
    assert intraday.find_hourly_spikes(s, bars) == []  # only 100 prior changes
    s = hourly_series({T0: 0.05}, T0 - timedelta(days=8), 24 * 9)
    assert intraday.find_hourly_spikes(s, set()) == []  # holiday / half day: no matching bar


def test_window_ends_by_20_utc_in_summer_and_winter():
    # EDT session bars start at 13:30 UTC; the last full-window hour is 18:30–19:30.
    summer = datetime(2025, 7, 7, 18, 30, tzinfo=UTC)
    bars = set(session_bars(3, first=date(2025, 7, 7), opens=(13, 30)))
    for end, ok in ((summer + timedelta(hours=1), True), (summer + timedelta(hours=2), False)):
        s = hourly_series({end: 0.05}, end - timedelta(days=8), 24 * 9)
        assert bool(intraday.find_hourly_spikes(s, bars)) is ok


def frame(bars, cols):
    return pd.DataFrame(cols, index=pd.DatetimeIndex(bars))


def test_scores_sign_by_odds_and_beta_and_split_pre_post():
    bars = session_bars(5)
    n = len(bars)
    i0 = bars.index(T1 - timedelta(hours=1))  # bar 0: the odds change's hour
    up, down = np.zeros(n), np.zeros(n)
    up[i0 + 2], down[i0 + 2] = 0.01, -0.01   # both move as predicted at +2
    up[i0 - 3] = 0.004                       # UP leads by three bars
    ar = frame(bars, {"UP": up, "DOWN": down})
    scorer = intraday.Scorer(ar, lambda sid, d: {"UP": 1.0, "DOWN": -0.5}, top_n=20)
    ev = scorer.score({"series": "s", "t": T1.isoformat(), "dp": 0.05})
    assert ev["path"][2] == pytest.approx(0.01)
    assert ev["post"] == pytest.approx(0.01)
    assert ev["pre"] == pytest.approx(0.004 * 1.0 / 1.5)
    assert ev["trading_day"] == "2025-01-07"
    flipped = scorer.score({"series": "s", "t": T1.isoformat(), "dp": -0.05})
    assert flipped["post"] == pytest.approx(-0.01)


def test_scores_use_only_the_top_n_and_skip_spikes_without_room():
    bars = session_bars(5)
    ar = frame(bars, {"A": np.full(len(bars), 0.01), "B": np.full(len(bars), -0.01)})
    scorer = intraday.Scorer(ar, lambda sid, d: {"A": 1.0, "B": 0.1}, top_n=1)
    ev = scorer.score({"series": "s", "t": T1.isoformat(), "dp": 0.05})
    assert ev["stocks"] == ["A"] and ev["post"] == pytest.approx(0.06)
    assert scorer.score({"series": "s", "t": (bars[2] + timedelta(hours=1)).isoformat(), "dp": 0.05}) is None
    assert scorer.score({"series": "s", "t": (bars[-2] + timedelta(hours=1)).isoformat(), "dp": 0.05}) is None


def test_hourly_abnormal_uses_that_days_market_beta_and_join_dates():
    bars = session_bars(2)[:3]
    closes = frame(bars, {"SPY": [100.0, 101.0, 102.01], "X": [50.0, 51.0, 52.02], "NEW": [10.0, 10.0, 10.0]})
    beta = pd.DataFrame({"SPY": [1.0], "X": [2.0], "NEW": [1.0]}, index=[date(2025, 1, 6)])
    members = [{"yf": "X", "added": None}, {"yf": "NEW", "added": "2025-02-01"}]
    ar = intraday.hourly_abnormal(closes, beta, members)
    assert ar["X"].iloc[1] == pytest.approx(0.02 - 2.0 * 0.01)
    assert ar["NEW"].isna().all()


def test_summary_clusters_by_date_and_reports_verdicts():
    def ev(day, post):
        return {"trading_day": day, "post": post, "pre": 0.0, "path": {k: 0.0 for k in intraday.OFFSETS}}
    events = [ev("2025-01-06", 0.02), ev("2025-01-06", 0.0), ev("2025-01-07", 0.03), ev("2025-01-08", 0.01)]
    s = intraday.summarize(events, placebo=[[ev("2025-01-06", 0.0)]])
    h1a = s["tests"]["H1a post +1..+6"]
    assert h1a["dates"] == 3 and h1a["mean_bp"] == pytest.approx((0.01 + 0.03 + 0.01) / 3 * 10_000)
    assert h1a["placebo_p"] == pytest.approx(0.5)
    assert intraday.verdict(3.1) == "evidence" and intraday.verdict(2.5) == "suggestive" and intraday.verdict(1) == "not supported"


def test_chain_hourly_breaks_changes_at_rolls():
    h = lambda k: T0 + timedelta(hours=k)
    near = {"event": "Near", "end": date(2025, 1, 8), "prices": {h(0): 0.1, h(1): 0.2, h(30): 0.9}}
    far = {"event": "Far", "end": date(2025, 3, 1), "prices": {h(k): 0.5 + k / 100 for k in range(32)}}
    rows = history.chain_hourly([near, far], min_days_to_expiry=2)
    assert rows[1]["contract"] == "Near" and rows[1]["dp"] == pytest.approx(0.1)
    assert rows[2]["contract"] == "Far" and rows[2]["dp"] is None
    assert rows[30]["contract"] == "Far"  # Near is within a day of expiry by then


def test_sample_takes_the_last_print_at_or_before_each_cutoff():
    prints = [(int(T0.timestamp()) - 600, 0.4), (int(T0.timestamp()) + 60, 0.6)]
    out = history._sample(prints, [T0 - timedelta(hours=1), T0, T0 + timedelta(hours=1)])
    assert out == {T0: 0.4, T0 + timedelta(hours=1): 0.6}
