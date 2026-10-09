"""Latest stock prices via yfinance, cached. Missing prices come back absent rather than failing the request."""

from __future__ import annotations

import asyncio
import time

import yfinance as yf

PRICE_TTL = 300.0
_cache: dict[str, tuple[float, float]] = {}


def _download(symbols: list[str]) -> dict[str, float]:
    data = yf.download(symbols, period="5d", interval="1d", progress=False, auto_adjust=False, threads=True)
    closes = data["Close"]
    out = {}
    for symbol in symbols:
        series = (closes[symbol] if symbol in closes else closes).dropna()
        if len(series):
            out[symbol] = float(series.iloc[-1])
    return out


async def latest(symbols: list[str]) -> dict[str, float]:
    now = time.monotonic()
    missing = [s for s in symbols if s not in _cache or _cache[s][0] < now]
    if missing:
        try:
            fresh = await asyncio.to_thread(_download, missing)
        except Exception:
            fresh = {}
        for symbol, price in fresh.items():
            _cache[symbol] = (now + PRICE_TTL, price)
    return {s: _cache[s][1] for s in symbols if s in _cache}
