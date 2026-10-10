"""Polymarket client: resolves configured signals to live markets via the public Gamma and CLOB APIs."""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

import httpx

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
# Polymarket's CDN rejects requests without a user agent.
HEADERS = {"User-Agent": "polyslice/0.1 (hackknight demo)"}
SIGNAL_TTL = 60.0
HISTORY_TTL = 300.0
EXCLUDED_FEED_TAGS = {"sports", "games", "esports", "nfl", "nba", "mlb", "nhl", "soccer", "cfb", "tennis", "ufc"}

_cache: dict[str, tuple[float, Any]] = {}


async def _cached(key: str, ttl: float, fetch):
    hit = _cache.get(key)
    if hit and hit[0] > time.monotonic():
        return hit[1]
    value = await fetch()
    _cache[key] = (time.monotonic() + ttl, value)
    return value


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(headers=HEADERS, timeout=15.0)


def _yes_price(market: dict[str, Any]) -> float | None:
    try:
        return float(json.loads(market["outcomePrices"])[0])
    except (KeyError, ValueError, TypeError, IndexError):
        return None


def _market_summary(event: dict[str, Any], market: dict[str, Any]) -> dict[str, Any]:
    tokens = json.loads(market.get("clobTokenIds") or "[]")
    return {
        "question": market["question"].strip(),
        "event_title": event.get("title"),
        "url": f"https://polymarket.com/event/{event['slug']}",
        "price": _yes_price(market),
        "changes": {
            "1d": market.get("oneDayPriceChange"),
            "1w": market.get("oneWeekPriceChange"),
            "1m": market.get("oneMonthPriceChange"),
        },
        "volume": float(market.get("volume") or 0),
        "volume_24h": float(market.get("volume24hr") or 0),
        "end_date": market.get("endDate"),
        "token_id": tokens[0] if tokens else None,
    }


def _is_live(market: dict[str, Any]) -> bool:
    price = _yes_price(market)
    return bool(market.get("active")) and not market.get("closed") and price is not None and 0.0 < price < 1.0


async def _resolve(client: httpx.AsyncClient, cfg: dict[str, Any]) -> dict[str, Any]:
    base = {"id": cfg["id"], "label": cfg["label"], "betas": cfg["betas"], "price": None, "status": "unavailable"}
    try:
        r = await client.get(f"{GAMMA}/public-search", params={
            "q": cfg["query"], "limit_per_type": 20, "events_status": "active",
        })
        r.raise_for_status()
    except httpx.HTTPError as e:
        return {**base, "error": str(e)}

    needle = cfg["match"].lower()
    best = None
    for event in r.json().get("events") or []:
        if event.get("closed"):
            continue
        for market in event.get("markets") or []:
            if needle in market.get("question", "").lower() and _is_live(market):
                if best is None or float(market.get("volume") or 0) > float(best[1].get("volume") or 0):
                    best = (event, market)
    if best is None:
        return base
    return {**base, **_market_summary(*best), "status": "live"}


async def signals(config: list[dict[str, Any]]) -> list[dict[str, Any]]:
    async def fetch():
        async with _client() as client:
            return await asyncio.gather(*(_resolve(client, cfg) for cfg in config))

    return await _cached("signals", SIGNAL_TTL, fetch)


async def history(token_id: str, interval: str = "1m", fidelity: int = 360) -> list[dict[str, float]]:
    """Price history for one outcome token: [{t: unix seconds, p: probability}]."""
    async def fetch():
        async with _client() as client:
            r = await client.get(f"{CLOB}/prices-history", params={
                "market": token_id, "interval": interval, "fidelity": fidelity,
            })
            r.raise_for_status()
            return r.json().get("history", [])

    return await _cached(f"history:{token_id}:{interval}:{fidelity}", HISTORY_TTL, fetch)


async def trending(limit: int = 20) -> list[dict[str, Any]]:
    """Highest-volume live non-sports markets: the raw feed scope suggestions can draw on."""
    async def fetch():
        async with _client() as client:
            r = await client.get(f"{GAMMA}/events", params={
                "active": "true", "closed": "false", "order": "volume24hr", "ascending": "false", "limit": 60,
            })
            r.raise_for_status()
            out = []
            for event in r.json():
                tags = {t.get("slug") for t in event.get("tags") or []}
                if tags & EXCLUDED_FEED_TAGS:
                    continue
                live = [m for m in event.get("markets") or [] if _is_live(m)]
                if not live:
                    continue
                market = max(live, key=lambda m: float(m.get("volume24hr") or 0))
                out.append({**_market_summary(event, market), "tags": sorted(t for t in tags if t)})
            return out

    return (await _cached("trending", SIGNAL_TTL, fetch))[:limit]
