"""Research universe: S&P 500 constituents (with GICS industries) plus the ETFs/ADRs we track.

    uv run python -m polyslice_api.universe   # refresh data/sp500.json and the price cache

`added` is the date a stock joined the index. Research code ignores a stock
before that date, which removes part of the survivorship bias (stocks that grew
into the index), though not the part from stocks that were removed.
"""

from __future__ import annotations

import io
import json
from datetime import date
from importlib import resources
from pathlib import Path
from typing import Any

import pandas as pd

DATA = Path(__file__).resolve().parent / "data"
PRICE_CACHE = Path(__file__).resolve().parents[2] / ".cache" / "prices" / "daily.csv.gz"
PRICE_START = "2023-01-01"
WIKI = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"


def build_constituents() -> dict[str, Any]:
    import httpx

    r = httpx.get(WIKI, headers={"User-Agent": "polyslice-research/0.1 (hackathon)"}, timeout=30, follow_redirects=True)
    r.raise_for_status()
    table = pd.read_html(io.StringIO(r.text), attrs={"id": "constituents"})[0]
    members = [
        {
            "symbol": row["Symbol"],
            "yf": row["Symbol"].replace(".", "-"),  # BRK.B -> BRK-B
            "name": row["Security"],
            "sector": row["GICS Sector"],
            "sub_industry": row["GICS Sub-Industry"],
            "added": str(row["Date added"])[:10] if pd.notna(row["Date added"]) else None,
        }
        for _, row in table.iterrows()
    ]
    # Instruments the app tracks that aren't S&P 500 members (bond ETFs, ADRs, smaller caps).
    app = json.loads(resources.files(__package__).joinpath("data/universe.json").read_text())
    have = {m["symbol"] for m in members}
    extras = [
        {"symbol": h["symbol"], "yf": h["symbol"], "name": h["name"], "sector": f"Extra: {s['name']}",
         "sub_industry": f"Extra: {s['name']}", "added": None}
        for s in app["sectors"] for h in s["holdings"] if h["symbol"] not in have
    ]
    return {"as_of": date.today().isoformat(), "source": WIKI, "members": members + extras}


def constituents() -> list[dict[str, Any]]:
    return json.loads((DATA / "sp500.json").read_text())["members"]


def download_prices(symbols: list[str], start: str = PRICE_START) -> pd.DataFrame:
    import yfinance as yf

    data = yf.download(symbols, start=start, interval="1d", progress=False, auto_adjust=True, threads=True)
    return data["Close"].dropna(how="all")


def daily_closes(symbols: list[str] | None = None) -> dict[str, dict[date, float]]:
    """{yf symbol: {date: adjusted close}} from the on-disk cache."""
    frame = pd.read_csv(PRICE_CACHE, index_col=0, parse_dates=True)
    cols = frame.columns if symbols is None else [s for s in symbols if s in frame.columns]
    return {c: {ts.date(): float(v) for ts, v in frame[c].dropna().items()} for c in cols}


def _main() -> None:
    universe = build_constituents()
    (DATA / "sp500.json").write_text(json.dumps(universe, indent=1))
    symbols = sorted({m["yf"] for m in universe["members"]} | {"SPY"})
    prices = download_prices(symbols)
    PRICE_CACHE.parent.mkdir(parents=True, exist_ok=True)
    prices.to_csv(PRICE_CACHE)
    missing = [s for s in symbols if s not in prices.columns or prices[s].dropna().empty]
    print(f"{len(universe['members'])} members ({sum(1 for m in universe['members'] if not m['sector'].startswith('Extra'))} S&P 500), "
          f"{prices.shape[0]} days {prices.index[0].date()} → {prices.index[-1].date()}, missing prices: {missing or 'none'}")


if __name__ == "__main__":
    _main()
