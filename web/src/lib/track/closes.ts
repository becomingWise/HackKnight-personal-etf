// Daily closes for the track record: the 40 universe tickers and SPY, in the stock_closes table.
// They are loaded by a local script (`pnpm closes:load`); nothing on Vercel fetches prices.
import { db } from "../db/client";
import { SYMBOLS } from "../stocks/universe";

export const BENCHMARK = "SPY";
export const CLOSES_START = "2026-07-01";
/** Every symbol the track record needs a price for. */
export const CLOSE_SYMBOLS = [BENCHMARK, ...SYMBOLS];

export type CloseRow = { symbol: string; day: string; close: number };

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Rows from what scripts/closes.py prints: { SYMBOL: { "YYYY-MM-DD": close } }. Anything that is
 * not a known symbol, a day or a positive price is left out rather than stored.
 */
export function closeRows(
  payload: unknown,
  symbols: readonly string[] = CLOSE_SYMBOLS,
): CloseRow[] {
  const rows: CloseRow[] = [];
  if (!payload || typeof payload !== "object") return rows;
  for (const symbol of symbols) {
    const days = (payload as Record<string, unknown>)[symbol];
    if (!days || typeof days !== "object") continue;
    for (const [day, close] of Object.entries(days as Record<string, unknown>)) {
      if (DAY.test(day) && typeof close === "number" && Number.isFinite(close) && close > 0) {
        rows.push({ symbol, day, close });
      }
    }
  }
  return rows;
}

/** Inserts or updates the closes. Returns how many rows were written. */
export async function saveCloses(rows: CloseRow[]): Promise<number> {
  const sql = db();
  let written = 0;
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const result = await sql`
      insert into stock_closes ${sql(chunk, "symbol", "day", "close")}
      on conflict (symbol, day) do update set close = excluded.close, updated_at = now()`;
    written += result.count;
  }
  return written;
}

export type ClosesCoverage = {
  symbols: number;
  rows: number;
  firstDay: string | null;
  lastDay: string | null;
  /** Symbols with no close on the last day (a delisting or a failed download). */
  missingOnLastDay: string[];
};

export async function closesCoverage(
  symbols: readonly string[] = CLOSE_SYMBOLS,
): Promise<ClosesCoverage> {
  const sql = db();
  const [totals] = await sql<
    { symbols: number; rows: number; first_day: string | null; last_day: string | null }[]
  >`
    select count(distinct symbol)::int as symbols, count(*)::int as rows,
           min(day)::text as first_day, max(day)::text as last_day
    from stock_closes`;
  const present = await sql<{ symbol: string }[]>`
    select symbol from stock_closes where day = (select max(day) from stock_closes)`;
  const have = new Set(present.map((row) => row.symbol));
  return {
    symbols: totals.symbols,
    rows: totals.rows,
    firstDay: totals.first_day,
    lastDay: totals.last_day,
    missingOnLastDay: symbols.filter((symbol) => !have.has(symbol)),
  };
}
