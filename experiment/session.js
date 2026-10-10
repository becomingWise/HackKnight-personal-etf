import { allocate } from "./math.js";

export const SESSION_KEY = "basketlab.flow.v2";

export function createBasket(idea, result, allowed) {
  const candidates = result.stocks;
  if (!Array.isArray(candidates) || candidates.length < 7 || candidates.length > 10 ||
    new Set(candidates.map(s => s.symbol)).size !== candidates.length || candidates.some(s => !allowed.includes(s.symbol)) ||
    !["preview", "gemini"].includes(result.source)) throw new Error("The suggestion response was incomplete. Your existing basket is unchanged.");
  return { version: 2, idea, candidates, symbols: candidates.map(s => s.symbol), removed: [], source: result.source, summary: result.summary, paperAmountCents: 0 };
}

export function restoreBasket(raw, allowed) {
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 2 || typeof data.idea !== "string" || data.idea.length > 500) return null;
    const valid = createBasket(data.idea, { stocks: data.candidates, source: data.source, summary: data.summary }, allowed);
    if (!Array.isArray(data.symbols) || new Set(data.symbols).size !== data.symbols.length || data.symbols.some(s => !valid.symbols.includes(s))) return null;
    valid.symbols = data.symbols;
    const amount = data.paperAmountCents === undefined ? 0 : data.paperAmountCents;
    if (!Number.isSafeInteger(amount) || amount < 0) return null;
    valid.paperAmountCents = amount;
    valid.removed = Array.isArray(data.removed) ? data.removed.filter(row => valid.candidates.some(s => s.symbol === row.symbol) &&
      !valid.symbols.includes(row.symbol) && Number.isInteger(row.index) && row.index >= 0 && row.index < 10).slice(-10) : [];
    return valid;
  } catch { return null; }
}

export function deleteHolding(basket, symbol) {
  const index = basket.symbols.indexOf(symbol);
  if (index < 0) return basket;
  return { ...basket, symbols: basket.symbols.filter(s => s !== symbol), removed: [...basket.removed, { symbol, index }] };
}

export function undoDeletion(basket) {
  if (!basket.removed.length) return basket;
  const { symbol, index } = basket.removed.at(-1), symbols = [...basket.symbols];
  if (!symbols.includes(symbol)) symbols.splice(Math.min(index, symbols.length), 0, symbol);
  return { ...basket, symbols, removed: basket.removed.slice(0, -1) };
}

/** Parse USD without rounding an invalid fractional cent or losing integer precision. */
export function parseAmountCents(input) {
  const text = String(input).trim();
  if (text.length > 22 || !/^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/.test(text))
    throw new Error("Enter a positive USD amount with up to two decimal places, such as 100.50.");
  const [whole, fraction = ""] = text.split(".");
  const amount = BigInt(whole || "0") * 100n + BigInt(fraction.padEnd(2, "0"));
  if (amount <= 0n) throw new Error("Enter an amount greater than $0.");
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("This amount is too large. Enter a smaller amount.");
  return Number(amount);
}

/** Format the cent balance exactly, even above the precision of fractional-dollar numbers. */
export function formatUsdCents(cents) {
  if (!Number.isSafeInteger(cents) || cents < 0) throw new Error("Invalid paper amount.");
  const amount = BigInt(cents);
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).formatToParts(amount / 100n)
    .map(part => part.type === "fraction" ? String(amount % 100n).padStart(2, "0") : part.value).join("");
}

export function changePaperAmount(basket, mode, amountCents) {
  const current = basket.paperAmountCents ?? 0;
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(amountCents) || amountCents <= 0)
    throw new Error("Enter a valid positive paper amount.");
  if (!["buy", "sell"].includes(mode)) throw new Error("Choose Buy or Sell.");
  if (mode === "buy" && !basket.symbols.length) throw new Error("Add or restore a company before buying your basket.");
  if (mode === "sell" && amountCents > current) throw new Error("The sale cannot exceed your paper amount.");
  const next = mode === "buy" ? current + amountCents : current - amountCents;
  if (!Number.isSafeInteger(next)) throw new Error("The total paper amount is too large. Enter a smaller amount.");
  return { ...basket, paperAmountCents: next };
}

export function paperHoldings(basket, catalog) {
  const rows = allocate(basket.symbols.map(symbol => catalog.find(s => s.symbol === symbol)));
  const amount = basket.paperAmountCents ?? 0;
  if (!Number.isSafeInteger(amount) || amount < 0) throw new Error("Invalid paper amount.");
  const base = rows.length ? Math.floor(amount / rows.length) : 0;
  const remainder = rows.length ? amount % rows.length : 0;
  return rows.map((row, i) => {
    const allocatedCents = base + Number(i < remainder);
    return { ...row, allocatedCents, allocatedDollars: allocatedCents / 100 };
  });
}

export function exportBasket(basket, catalog, exportedAt = new Date().toISOString()) {
  const rows = paperHoldings(basket, catalog);
  return { idea: basket.idea, suggestedBy: basket.source, weightingMethod: "equal", mode: "paper",
    paperAmountCents: basket.paperAmountCents ?? 0, paperAmountUsd: (basket.paperAmountCents ?? 0) / 100,
    unallocatedCents: rows.length ? 0 : basket.paperAmountCents ?? 0, holdings: rows,
    note: "Paper funding only, without a trade ledger or profit/loss accounting. Event scenarios do not change allocations.", exportedAt };
}
