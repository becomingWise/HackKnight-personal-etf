export const SESSION_KEY = "basketlab.flow.v2";

export function createBasket(idea, result, allowed) {
  const candidates = result.stocks;
  if (!Array.isArray(candidates) || candidates.length < 7 || candidates.length > 10 ||
    new Set(candidates.map(s => s.symbol)).size !== candidates.length || candidates.some(s => !allowed.includes(s.symbol)) ||
    !["preview", "gemini"].includes(result.source)) throw new Error("The suggestion response was incomplete. Your existing basket is unchanged.");
  return { version: 2, idea, candidates, symbols: candidates.map(s => s.symbol), removed: [], source: result.source, summary: result.summary };
}

export function restoreBasket(raw, allowed) {
  try {
    const data = JSON.parse(raw);
    if (data?.version !== 2 || typeof data.idea !== "string" || data.idea.length > 500) return null;
    const valid = createBasket(data.idea, { stocks: data.candidates, source: data.source, summary: data.summary }, allowed);
    if (!Array.isArray(data.symbols) || new Set(data.symbols).size !== data.symbols.length || data.symbols.some(s => !valid.symbols.includes(s))) return null;
    valid.symbols = data.symbols;
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
