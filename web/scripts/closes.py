"""Prints daily adjusted closes as JSON, using Hao's price code unchanged
(backend/src/polyslice_api/prices.py, yfinance).

    python scripts/closes.py 2026-07-01 SPY NVDA TSM ...
    -> {"SPY": {"2026-07-01": 612.3, ...}, "NVDA": {...}}

Run through `pnpm closes:load`, which writes the result to the stock_closes table. Needs a Python
with yfinance:

    python -m venv .venv-closes
    .venv-closes\\Scripts\\python -m pip install yfinance        (Windows)

It never modifies /backend.
"""

import asyncio
import importlib.util
import json
import sys
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent
PRICES = WEB.parent / "backend" / "src" / "polyslice_api" / "prices.py"


def load_prices():
    # Loaded by path: the package's other modules need fastapi, which this script does not.
    spec = importlib.util.spec_from_file_location("polyslice_prices", PRICES)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main() -> int:
    if len(sys.argv) < 3:
        print("Usage: closes.py <start YYYY-MM-DD> <SYMBOL> [SYMBOL ...]", file=sys.stderr)
        return 2
    start, symbols = sys.argv[1], sys.argv[2:]
    closes = asyncio.run(load_prices().daily_closes(symbols, start))
    json.dump(
        {symbol: {day.isoformat(): close for day, close in days.items()} for symbol, days in closes.items()},
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
