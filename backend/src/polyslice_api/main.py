from __future__ import annotations

import json
from datetime import datetime, timezone
from importlib import resources
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import engine, polymarket, prices

UNIVERSE = json.loads(resources.files(__package__).joinpath("data/universe.json").read_text())
SECTORS = UNIVERSE["sectors"]
SIGNAL_CONFIG = UNIVERSE["signals"]
SECTOR_IDS = {s["id"] for s in SECTORS}

app = FastAPI(title="PolySlice API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
    allow_methods=["*"],
    allow_headers=["*"],
)


class BasketRequest(BaseModel):
    scope: list[str] = Field(min_length=1)
    window: Literal["1d", "1w", "1m"] = "1w"
    sensitivity: float = Field(2.0, ge=0, le=10)
    # What-if probabilities keyed by signal id, overriding the live odds.
    overrides: dict[str, float] = {}


class TicketRequest(BasketRequest):
    amount: float = Field(gt=0, le=10_000_000)


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


def _check_scope(scope: list[str]) -> None:
    unknown = set(scope) - SECTOR_IDS
    if unknown:
        raise HTTPException(422, f"Unknown sectors: {', '.join(sorted(unknown))}")


async def _basket(req: BasketRequest):
    _check_scope(req.scope)
    live = await polymarket.signals(SIGNAL_CONFIG)
    holdings = engine.scope_holdings(SECTORS, req.scope)
    rows = engine.reweight(holdings, live, window=req.window, sensitivity=req.sensitivity, overrides=req.overrides)
    return live, rows


@app.get("/api/health")
async def health():
    return {"ok": True, "time": _now()}


@app.get("/api/sectors")
async def sectors():
    return SECTORS


@app.get("/api/signals")
async def signals():
    return {"as_of": _now(), "signals": await polymarket.signals(SIGNAL_CONFIG)}


@app.get("/api/signals/{signal_id}/history")
async def signal_history(signal_id: str, interval: Literal["1d", "1w", "1m", "max"] = "1m"):
    live = {s["id"]: s for s in await polymarket.signals(SIGNAL_CONFIG)}
    signal = live.get(signal_id)
    if signal is None:
        raise HTTPException(404, "Unknown signal")
    if not signal.get("token_id"):
        return {"history": []}
    fidelity = {"1d": 15, "1w": 60, "1m": 360, "max": 1440}[interval]
    return {"history": await polymarket.history(signal["token_id"], interval, fidelity)}


@app.get("/api/feed")
async def feed(limit: int = 20):
    mapped = {s.get("question") for s in await polymarket.signals(SIGNAL_CONFIG)}
    items = await polymarket.trending(limit)
    return {"as_of": _now(), "items": [{**i, "mapped": i["question"] in mapped} for i in items]}


@app.post("/api/basket")
async def basket(req: BasketRequest):
    live, rows = await _basket(req)
    relevant = []
    for s in engine.relevant_signals(rows, live):
        move = engine.signal_move(s, req.window, req.overrides)
        symbols = {r["symbol"] for r in rows}
        relevant.append({
            **{k: v for k, v in s.items() if k != "betas"},
            "betas": {sym: b for sym, b in s["betas"].items() if sym in symbols},
            "move": move,
        })
    return {
        "as_of": _now(),
        "holdings": rows,
        "signals": relevant,
        "suggestions": engine.expansion_suggestions(
            SECTORS, req.scope, live, window=req.window, sensitivity=req.sensitivity,
        ),
    }


@app.post("/api/ticket")
async def ticket(req: TicketRequest):
    _, rows = await _basket(req)
    quotes = await prices.latest([r["symbol"] for r in rows])
    lines = engine.trade_ticket(rows, req.amount, quotes)
    return {
        "as_of": _now(),
        "amount": req.amount,
        "lines": lines,
        "simulated": True,
    }
