// Copies the tickers and Polymarket signals the weighting backend knows
// (../backend/src/polyslice_api/data/universe.json) into the web app, so findStocks only
// returns symbols that POST /api/weights can tilt. Run after the universe changes:
//   pnpm sync:universe
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const source = path.join(
  process.cwd(),
  "..",
  "backend",
  "src",
  "polyslice_api",
  "data",
  "universe.json",
);
const target = path.join(process.cwd(), "src", "lib", "stocks", "universe.data.json");

const universe = JSON.parse(await readFile(source, "utf8"));
const out = {
  sectors: universe.sectors.map((s) => ({
    id: s.id,
    name: s.name,
    blurb: s.blurb,
    holdings: s.holdings.map((h) => ({ symbol: h.symbol, name: h.name })),
  })),
  signals: universe.signals.map((s) => ({
    id: s.id,
    label: s.label,
    query: s.query,
    match: s.match ?? null,
    betas: s.betas,
  })),
};
await writeFile(target, JSON.stringify(out, null, 2) + "\n");
const count = out.sectors.reduce((n, s) => n + s.holdings.length, 0);
console.log(
  `Wrote ${count} tickers and ${out.signals.length} signals to ${path.relative(process.cwd(), target)}`,
);
