"""Long odds histories built by chaining expiring Polymarket contracts, like rolling futures.

A topic such as "Fed cuts at the next meeting" is a new market every meeting.
For each day we use the nearest-expiry contract that still has at least
`min_days_to_expiry` days left, and record its price plus its change since the
previous day *within the same contract*. Changes, not levels, are what chain
cleanly: a roll from a 2025 contract to a 2026 one is not a move in the odds.

Run `uv run python -m polyslice_api.history` to (re)build the on-disk cache.
"""

from __future__ import annotations

import asyncio
import bisect
import json
import re
import time
from datetime import date, datetime, time as dtime, timedelta, timezone
from importlib import resources
from pathlib import Path
from typing import Any

import httpx

from .polymarket import CLOB, GAMMA, HEADERS

SERIES = json.loads(resources.files(__package__).joinpath("data/series.json").read_text())["series"]
CACHE_DIR = Path(__file__).resolve().parents[2] / ".cache" / "series"
CACHE_TTL = 6 * 3600
DAY = 86_400
CHUNK = 14 * DAY  # longest window the CLOB serves at hourly fidelity
CLOSE_UTC = dtime(20, 0)


async def _events(client: httpx.AsyncClient, query: str) -> list[dict[str, Any]]:
    out, page = [], 1
    while True:
        r = await client.get(f"{GAMMA}/public-search", params={
            "q": query, "limit_per_type": 50, "events_status": "all", "page": page,
        })
        r.raise_for_status()
        body = r.json()
        out += body.get("events") or []
        if not (body.get("pagination") or {}).get("hasMore") or page >= 10:
            return out
        page += 1


async def _daily_prices(client: httpx.AsyncClient, token: str, sem: asyncio.Semaphore) -> dict[date, float]:
    """One price per calendar day: the last hourly print at or before the US close (20:00 UTC).

    Sampling at the close lines each day's odds change up with that day's stock
    close-to-close return. The CLOB only serves hourly data in short windows, so
    first find the token's lifespan from the coarse history, then page through it.
    """
    async with sem:
        r = await client.get(f"{CLOB}/prices-history", params={"market": token, "interval": "max", "fidelity": 1440})
    r.raise_for_status()
    coarse = r.json().get("history") or []
    if not coarse:
        return {}
    first, last = min(h["t"] for h in coarse) - DAY, max(h["t"] for h in coarse) + DAY

    async def chunk(start: int) -> list[dict[str, float]]:
        for attempt in range(3):
            try:
                async with sem:
                    r = await client.get(f"{CLOB}/prices-history", params={
                        "market": token, "startTs": start, "endTs": min(start + CHUNK, last), "fidelity": 60,
                    })
                r.raise_for_status()
                return r.json().get("history") or []
            except httpx.HTTPError:
                await asyncio.sleep(1 + attempt)
        return []

    pages = await asyncio.gather(*(chunk(t) for t in range(first, last, CHUNK)))
    prints = sorted({h["t"]: h["p"] for page in pages for h in page}.items())
    if not prints:
        return {}

    out: dict[date, float] = {}
    day = datetime.fromtimestamp(prints[0][0], timezone.utc).date()
    end_day = datetime.fromtimestamp(prints[-1][0], timezone.utc).date()
    times = [t for t, _ in prints]
    while day <= end_day:
        cutoff = datetime.combine(day, CLOSE_UTC, tzinfo=timezone.utc).timestamp()
        i = bisect.bisect_right(times, cutoff)
        if i:
            out[day] = float(prints[i - 1][1])
        day += timedelta(days=1)
    return out


async def contracts(spec: dict[str, Any], client: httpx.AsyncClient) -> list[dict[str, Any]]:
    """Every event matching the spec, with its matching markets' daily prices summed."""
    title_re = re.compile(spec["event_title"])
    needle = spec["markets"].lower()
    found: dict[str, dict[str, Any]] = {}
    for q in spec["queries"]:
        for e in await _events(client, q):
            if title_re.match(e.get("title", "").strip()) and e.get("endDate"):
                found[e["id"]] = e

    # "sum": the event is one contract whose matching markets add up (e.g. 25bp + 50bp cut).
    # "each": every matching market is its own contract (an event listing several deadlines).
    groups = []
    for e in found.values():
        markets = [m for m in e.get("markets") or [] if needle in m.get("question", "").lower() and m.get("clobTokenIds")]
        if spec.get("legs", "sum") == "each":
            groups += [(m["question"].strip(), e["slug"], m.get("endDate") or e["endDate"], [m]) for m in markets]
        elif markets:
            groups.append((e["title"].strip(), e["slug"], e["endDate"], markets))

    sem = asyncio.Semaphore(12)
    out = []
    for name, slug, end, markets in groups:
        legs = await asyncio.gather(*(_daily_prices(client, json.loads(m["clobTokenIds"])[0], sem) for m in markets))
        days = set().union(*legs)
        # Only days where every leg has a price, so the sum isn't missing a piece.
        prices = {d: min(1.0, sum(leg[d] for leg in legs)) for d in days if all(d in leg for leg in legs)}
        if prices:
            out.append({
                "event": name,
                "slug": slug,
                "volume": sum(float(m.get("volume") or 0) for m in markets),
                "end": datetime.fromisoformat(end.replace("Z", "+00:00")).date(),
                "prices": prices,
            })
    # Nearest expiry first; for duplicate listings of the same meeting, the longer history wins.
    out.sort(key=lambda c: (c["end"], -len(c["prices"])))
    return out


def chain(contract_list: list[dict[str, Any]], min_days_to_expiry: int, until: date | None = None) -> list[dict[str, Any]]:
    """Daily rows {date, p, dp, contract}; dp is None on the first day of each contract."""
    if not contract_list:
        return []
    until = until or datetime.now(timezone.utc).date()
    day = min(min(c["prices"]) for c in contract_list)
    rows, prev = [], None
    while day <= until:
        active = next(
            (c for c in contract_list
             if (c["end"] - day).days >= min_days_to_expiry and day in c["prices"]),
            None,
        )
        if active is not None:
            p = active["prices"][day]
            same = prev is not None and prev["contract"] == active["event"]
            rows.append({
                "date": day.isoformat(),
                "p": p,
                "dp": p - prev["p"] if same else None,
                "contract": active["event"],
            })
            prev = rows[-1]
        else:
            prev = None
        day += timedelta(days=1)
    return rows


async def build(spec: dict[str, Any]) -> dict[str, Any]:
    async with httpx.AsyncClient(headers=HEADERS, timeout=30.0) as client:
        cs = await contracts(spec, client)
    rows = chain(cs, spec["min_days_to_expiry"])
    return {
        "id": spec["id"],
        "label": spec["label"],
        "betas": spec["betas"],
        "built_at": time.time(),
        "contracts": [
            {"event": c["event"], "slug": c["slug"], "end": c["end"].isoformat(), "volume": c["volume"],
             "first": min(c["prices"]).isoformat(), "days": len(c["prices"])}
            for c in cs
        ],
        "rows": rows,
    }


async def load(series_id: str, refresh: bool = False) -> dict[str, Any]:
    spec = next(s for s in SERIES if s["id"] == series_id)
    path = CACHE_DIR / f"{series_id}.json"
    if not refresh and path.exists():
        cached = json.loads(path.read_text())
        if time.time() - cached["built_at"] < CACHE_TTL:
            return cached
    data = await build(spec)
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data))
    return data


async def load_all(refresh: bool = False) -> list[dict[str, Any]]:
    return list(await asyncio.gather(*(load(s["id"], refresh) for s in SERIES)))


def as_history(series: dict[str, Any]) -> list[dict[str, float]]:
    """A synthetic odds path, in the CLOB history format, whose daily changes are the chained dp.

    Anchored to the latest real price, so recent levels are real and only older
    levels are shifted by the roll gaps. Use it for moves and z-scores, not levels.
    """
    rows = series["rows"]
    if not rows:
        return []
    level, path = rows[-1]["p"], []
    for row in reversed(rows):
        d = date.fromisoformat(row["date"])
        path.append({"t": int(datetime.combine(d, CLOSE_UTC, tzinfo=timezone.utc).timestamp()), "p": level})
        level -= row["dp"] or 0.0
    return path[::-1]


async def _main() -> None:
    for s in await load_all(refresh=True):
        rows = s["rows"]
        moves = [r["dp"] for r in rows if r["dp"] is not None]
        span = f"{rows[0]['date']} → {rows[-1]['date']}" if rows else "no data"
        print(f"{s['id']:<18} {len(s['contracts']):>3} contracts  {len(rows):>4} days  {span}  "
              f"rolls {sum(1 for r in rows if r['dp'] is None) - 1}  "
              f"daily σ {(sum(m * m for m in moves) / max(1, len(moves))) ** 0.5 * 100:.1f} pts")


if __name__ == "__main__":
    asyncio.run(_main())
