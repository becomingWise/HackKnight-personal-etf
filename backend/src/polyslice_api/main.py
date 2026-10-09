from __future__ import annotations

import asyncio
import json
from datetime import date, datetime, timedelta, timezone
from importlib import resources
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from . import backtest, engine, polymarket, prices

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


class BacktestRequest(BaseModel):
    scope: list[str] = Field(min_length=1)
    days: int = Field(180, ge=20, le=365)
    lookback_days: Literal[1, 7, 30] = 7
    sensitivity: float = Field(2.0, ge=0, le=10)
    cost_bps: float = Field(5.0, ge=0, le=100)
    mode: Literal["continuous", "spike"] = "continuous"
    z_threshold: float = Field(2.0, ge=0.5, le=10)
    hold_days: int = Field(10, ge=1, le=60)


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


@app.post("/api/backtest")
async def run_backtest(req: BacktestRequest):
    _check_scope(req.scope)
    live = await polymarket.signals(SIGNAL_CONFIG)
    holdings = engine.scope_holdings(SECTORS, req.scope)
    relevant = [s for s in engine.relevant_signals(holdings, live) if s.get("token_id")]
    start = (date.today() - timedelta(days=req.days)).isoformat()
    histories = await asyncio.gather(*(polymarket.history(s["token_id"], "max", 1440) for s in relevant))
    try:
        closes = await prices.daily_closes([h["symbol"] for h in holdings], start)
    except Exception as e:
        raise HTTPException(502, f"Stock price history unavailable: {e}")
    result = backtest.simulate(
        holdings,
        relevant,
        {s["id"]: h for s, h in zip(relevant, histories)},
        closes,
        lookback_days=req.lookback_days,
        sensitivity=req.sensitivity,
        cost_bps=req.cost_bps,
        mode=req.mode,
        z_threshold=req.z_threshold,
        hold_days=req.hold_days,
    )
    return {
        "as_of": _now(),
        **result,
        "signals": [
            {"id": s["id"], "label": s["label"], "history_start": h[0]["t"] if h else None}
            for s, h in zip(relevant, histories)
        ],
    }
