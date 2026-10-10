"""Generates golden answers from the REFERENCE Python weighting service (/backend) so the
TypeScript port in web/src/lib/weights can be checked against it.

Run from /web after any change to backend/src/polyslice_api/{engine,main}.py:

    pnpm parity:weights        (then: pnpm test)

Needs a Python with fastapi and httpx installed (yfinance is stubbed; no network is used):

    python -m venv .venv-parity
    .venv-parity\\Scripts\\python -m pip install fastapi httpx      (Windows)
    set PARITY_PYTHON=.venv-parity\\Scripts\\python

It never modifies /backend. Output: src/lib/weights/parity.fixture.json
"""

import importlib
import json
import random
import sys
import types
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(WEB.parent / "backend" / "src"))
# prices.py imports yfinance at module load; /api/weights never calls it.
sys.modules.setdefault("yfinance", types.ModuleType("yfinance"))

from fastapi.testclient import TestClient  # noqa: E402

main = importlib.import_module("polyslice_api.main")
engine = importlib.import_module("polyslice_api.engine")

SIGNALS = [
    {"id": "taiwan", "label": "China invades Taiwan", "status": "live", "price": 0.105,
     "question": "Will China invade Taiwan by December 31, 2027?",
     "url": "https://polymarket.com/event/will-china-invade-taiwan-by-december-31-2027",
     "changes": {"1d": 0.0, "1w": 0.015, "1m": -0.02},
     "betas": {"TSM": -1, "NVDA": -0.5, "AMD": -0.5, "AVGO": -0.4, "ASML": -0.5, "MU": -0.4, "INTC": 0.5,
               "AAPL": -0.6, "LMT": 0.6, "RTX": 0.6, "NOC": 0.6, "GD": 0.4, "LHX": 0.5, "PLTR": 0.4,
               "TLT": 0.3, "IEF": 0.2, "HYG": -0.3}},
    {"id": "chip_export_law", "label": "AI-chip export licensing becomes law", "status": "live", "price": 0.225,
     "question": "Will AI-chip export licensing become law this year?",
     "url": "https://polymarket.com/event/which-bills-will-become-law-in-2026",
     "changes": {"1w": -0.125},
     "betas": {"NVDA": -0.8, "AMD": -0.6, "INTC": 0.3, "AVGO": -0.3}},
    {"id": "no_cuts", "label": "No Fed rate cuts in 2026", "status": "live", "price": 0.956,
     "question": "Will no Fed rate cuts happen in 2026?", "url": "https://polymarket.com/event/fed-cuts-2026",
     "changes": {"1w": 0.01},
     "betas": {"TLT": -0.6, "IEF": -0.4, "HYG": -0.3, "LQD": -0.3, "JPM": 0.3, "BAC": 0.3, "SCHW": 0.2,
               "IBIT": -0.4, "COIN": -0.4, "MSTR": -0.5, "MARA": -0.5, "HOOD": -0.3, "ORCL": -0.2}},
    {"id": "btc_100k", "label": "Bitcoin reaches $100k in 2026", "status": "live", "price": 0.34,
     "question": "Will Bitcoin reach $100,000 in 2026?", "url": "https://polymarket.com/event/btc-100k-2026",
     "changes": {"1w": 0.3},
     "betas": {"IBIT": 1, "COIN": 0.9, "MSTR": 1.4, "MARA": 1.2, "HOOD": 0.5}},
    {"id": "recession", "label": "US recession by end of 2026", "status": "live", "price": 0.065,
     "question": "US recession by end of 2026?", "url": "https://polymarket.com/event/us-recession-2026",
     "changes": {"1w": None},
     "betas": {"JPM": -0.5, "BAC": -0.6, "GS": -0.5, "MS": -0.5, "TLT": 0.5, "HYG": -0.6}},
    {"id": "ukraine_ceasefire", "label": "Russia-Ukraine ceasefire agreement", "status": "live", "price": 0.34,
     "question": "Russia x Ukraine ceasefire agreement by March 31, 2027?",
     "url": "https://polymarket.com/event/russia-x-ukraine-ceasefire",
     "betas": {"LMT": -0.5, "RTX": -0.5, "NOC": -0.4, "GD": -0.4, "LHX": -0.4, "XOM": -0.2}},
    {"id": "hormuz_normal", "label": "Strait of Hormuz traffic normalizes", "status": "live", "price": 0.18,
     "question": "Strait of Hormuz traffic returns to normal by December 31?",
     "url": "https://polymarket.com/event/hormuz", "changes": {"1w": -0.005},
     "betas": {"XOM": -0.4, "CVX": -0.4, "COP": -0.5, "OXY": -0.6, "SLB": -0.3}},
    {"id": "openai_1t", "label": "OpenAI IPOs above $1T", "status": "unavailable", "price": None,
     "betas": {"MSFT": 0.5, "NVDA": 0.3}},
]

SYMBOLS = sorted({sym for s in SIGNALS for sym in s["betas"]} | {"GOOGL", "META", "SHY", "FSLR", "SOLAR_DEMO"})


def split(rng: random.Random, n: int) -> list[float]:
    """n weights with two decimals that total exactly 100."""
    cuts = sorted(rng.sample(range(1, 10000), n - 1)) if n > 1 else []
    edges = [0, *cuts, 10000]
    return [(b - a) / 100 for a, b in zip(edges, edges[1:])]


def cases() -> list[dict]:
    h = lambda *pairs: [{"symbol": s, "weightPct": w} for s, w in pairs]  # noqa: E731
    fixed = [
        h(("TSM", 50), ("INTC", 30), ("SOLAR_DEMO", 20)),
        h(("SOLAR_DEMO", 33.33), ("TIDAL_DEMO", 33.33), ("GRID_DEMO", 33.34)),
        h(("tsm", 50), ("intc", 50)),
        h(("TSM", 60), ("TSM", 40)),
        h(("TSM", 60)),
        h(("TSM", 100)),
        h(("NVDA", 33.33), ("TSM", 33.33), ("INTC", 33.34)),
        h(("NVDA", 25), ("AMD", 25), ("AVGO", 25), ("ASML", 25)),
        h(("IBIT", 20), ("COIN", 20), ("MSTR", 20), ("MARA", 20), ("HOOD", 20)),
        h(("MSTR", 50), ("MARA", 50)),
        h(("LMT", 33.34), ("RTX", 33.33), ("XOM", 33.33)),
        h(("JPM", 25), ("BAC", 25), ("GS", 25), ("MS", 25)),
        h(("GS", 50), ("MS", 50)),
        h(("XOM", 20), ("CVX", 20), ("COP", 20), ("OXY", 20), ("SLB", 20)),
        h(("MSFT", 50), ("GOOGL", 50)),
        h((" tsm ", 50), ("NVDA", 50)),
        h(("TSM", 50), ("tsm", 50)),
        h(("TLT", 33.333), ("IEF", 33.333), ("HYG", 33.334)),
        h(("TSM", 0), ("NVDA", 100)),
        h(("TSM", 50.004), ("NVDA", 50.004)),
        h(("TSM", 50.02), ("NVDA", 50.0)),
        h(("NVDA", 99.99), ("AMD", 0.01)),
    ]
    rng = random.Random(20261009)
    generated = []
    for _ in range(60):
        n = rng.randint(1, 8)
        symbols = rng.sample(SYMBOLS, n)
        generated.append(h(*zip(symbols, split(rng, n))))
    bodies = [{"idea": "parity", "holdings": x} for x in fixed + generated]
    bodies += [
        {"idea": "", "holdings": h(("TSM", 100))},
        {"idea": "x", "holdings": []},
        {"idea": "x", "holdings": h(("", 100))},
        {"idea": "x", "holdings": h(("TSM", 101))},
        {"idea": "x", "holdings": [{"symbol": "TSM", "weightPct": -1}, {"symbol": "NVDA", "weightPct": 101}]},
        {"holdings": h(("TSM", 100))},
    ]
    return bodies


async def fake_signals(_config):
    return SIGNALS


def main_() -> None:
    main.polymarket.signals = fake_signals
    client = TestClient(main.app)
    out = []
    for body in cases():
        r = client.post("/api/weights", json=body)
        data = r.json()
        if r.status_code == 200:
            for ev in data["evidence"]:
                ev["observedAt"] = "<observedAt>"
            out.append({"request": body, "status": 200, "response": data})
        else:
            # Only the status is compared for rejected input (and the message for our own 422s).
            detail = data.get("detail")
            out.append({"request": body, "status": r.status_code,
                        "detail": detail if isinstance(detail, str) else None})

    engine_cases = []
    rng = random.Random(7)
    for _ in range(40):
        weights = [rng.uniform(0, 40) for _ in range(rng.randint(1, 9))]
        total = sum(weights)
        weights = [100 * w / total for w in weights]
        engine_cases.append({"weights": weights, "rounded": engine.round_weights(weights)})
    formats = [{"x": x, "f0": f"{x:.0f}", "f1": f"{x:.1f}", "round": round(x)}
               for x in [0.5, 1.5, 2.5, 12.5, 22.5, 0.25, 33.35, 33.349999, 1.0, 0.96, 1.04, 7.45, 99.95, 50.05]]

    target = WEB / "src" / "lib" / "weights" / "parity.fixture.json"
    target.write_text(json.dumps(
        {"generatedBy": "scripts/gen-weights-parity.py", "signals": SIGNALS, "cases": out,
         "roundWeights": engine_cases, "formats": formats},
        indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    ok = sum(1 for c in out if c["status"] == 200)
    print(f"Wrote {len(out)} cases ({ok} answered, {len(out) - ok} rejected) to {target.relative_to(WEB)}")


main_()
