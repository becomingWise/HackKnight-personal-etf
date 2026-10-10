// Loads (and later refreshes) the daily closes of the 40 universe tickers and SPY into Tiger:
//   pnpm closes:load              since 2026-07-01
//   pnpm closes:load 2026-10-01   only from that day (a quick daily refresh)
// The prices come from Hao's code (backend/src/polyslice_api/prices.py) through scripts/closes.py,
// run with the Python in CLOSES_PYTHON (default: .venv-closes, see the header of closes.py).
// Rows are upserted, so running it again is safe.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { db } from "../src/lib/db/client";
import {
  CLOSES_START,
  CLOSE_SYMBOLS,
  closeRows,
  closesCoverage,
  saveCloses,
} from "../src/lib/track/closes";

const start = process.argv[2] ?? CLOSES_START;
if (!/^\d{4}-\d{2}-\d{2}$/.test(start)) {
  console.error("Usage: pnpm closes:load [YYYY-MM-DD]");
  process.exit(1);
}

const venv = path.join(
  ".venv-closes",
  process.platform === "win32" ? "Scripts" : "bin",
  process.platform === "win32" ? "python.exe" : "python",
);
const python = process.env.CLOSES_PYTHON || (existsSync(venv) ? venv : "python");

function download(symbols: readonly string[]) {
  const result = spawnSync(python, ["scripts/closes.py", start, ...symbols], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) {
    console.error(
      result.error
        ? `Could not run "${python}": ${result.error.message}. Set CLOSES_PYTHON (see scripts/closes.py).`
        : `scripts/closes.py failed:\n${result.stderr.slice(-2000)}`,
    );
    process.exit(1);
  }
  // yfinance may print notices before the JSON; the payload is the last line.
  return closeRows(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1) ?? "{}"), symbols);
}

const rows = download(CLOSE_SYMBOLS);
// A large batch sometimes comes back without one ticker: those are asked for once more.
const missing = CLOSE_SYMBOLS.filter((symbol) => !rows.some((row) => row.symbol === symbol));
if (missing.length) {
  console.log(`closes: retrying ${missing.join(", ")}`);
  rows.push(...download(missing));
}
if (!rows.length) {
  console.error("No closes came back; nothing was written.");
  process.exit(1);
}
const written = await saveCloses(rows);
const coverage = await closesCoverage();
console.log(
  `closes: ${written} rows written from ${start}; table has ${coverage.rows} rows, ` +
    `${coverage.symbols} symbols, ${coverage.firstDay} to ${coverage.lastDay}` +
    (coverage.missingOnLastDay.length
      ? `; no close on the last day for: ${coverage.missingOnLastDay.join(", ")}`
      : ""),
);
await db().end();
