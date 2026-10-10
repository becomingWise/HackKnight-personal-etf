// Live Polymarket context for the stock agent. The caller may pass the signals the weighting
// service tracks (id, label, question, Yes odds, 7-day change, β per ticker); the agent then sees
// one line per live signal and names the ones it used. Everything shown to a person about odds is
// built here from the live figures, never written by Gemini. Without signals nothing changes.

export const MAX_ODDS_MARKETS = 2;

/**
 * The live signals among what the caller passed, in one plain shape. Anything unusable (not an
 * array, not live, no odds, no betas) is left out, so a failed lookup simply means "no signals".
 * @returns {{ id: string, label: string, question: string, price: number, change7d: number | null, betas: Record<string, number> }[]}
 */
export function usableSignals(signals) {
  if (!Array.isArray(signals)) return [];
  const seen = new Set();
  const out = [];
  for (const signal of signals) {
    const id = typeof signal?.id === "string" ? signal.id.trim() : "";
    const price = signal?.price;
    if (!id || seen.has(id) || (signal.status ?? "live") !== "live") continue;
    if (typeof price !== "number" || !(price > 0 && price < 1)) continue;
    const betas = Object.fromEntries(
      Object.entries(signal.betas ?? {}).filter(([, beta]) => typeof beta === "number" && beta !== 0)
    );
    if (!Object.keys(betas).length) continue;
    const change = signal.changes?.["1w"];
    seen.add(id);
    out.push({
      id,
      label: String(signal.label ?? id),
      question: String(signal.question ?? signal.label ?? id),
      price,
      change7d: typeof change === "number" && Number.isFinite(change) ? change : null,
      betas
    });
  }
  return out;
}

const percent = price => {
  const value = Math.round(price * 100);
  return value < 1 ? "<1%" : value > 99 ? ">99%" : `${value}%`;
};
const signed = number => `${number > 0 ? "+" : ""}${number}`;

/** The prompt block: one compact line per live signal, then the rule for using them. */
export function signalsForPrompt(signals) {
  const lines = signals.map(signal => {
    const change = signal.change7d === null ? "7-day change unknown" : `7-day change ${signed(Math.round(signal.change7d * 1000) / 10)} pts`;
    const betas = Object.entries(signal.betas)
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
      .map(([symbol, beta]) => `${symbol} ${signed(beta)}`)
      .join(", ");
    return `- ${signal.id}: "${signal.question}" Yes ${percent(signal.price)}, ${change}. β: ${betas}`;
  });
  return (
    "LIVE POLYMARKET EVENTS (odds right now; β says how a ticker moves when the event gets more likely)\n" +
    `${lines.join("\n")}\n` +
    "Rule: the three stocks must fit the idea first. When the idea touches one of these events, prefer the fitting tickers " +
    'with the largest |β| for it, and list the ids of the events you used in "signals". Leave "signals" empty when no event applies.'
  );
}

const strongestBeta = (signal, symbols) => Math.max(0, ...symbols.map(symbol => Math.abs(signal.betas[symbol] ?? 0)));

/**
 * The server's check of the ids Gemini named: unknown ids are dropped, and so are ids with no β
 * on a picked ticker. The ones that pass come back strongest link first.
 * @param {unknown} ids
 * @param {{ symbol: string }[]} stocks
 * @param {ReturnType<typeof usableSignals>} signals
 * @returns {string[]}
 */
export function checkSignalIds(ids, stocks, signals) {
  if (!Array.isArray(ids)) return [];
  const symbols = stocks.map(stock => stock.symbol);
  const byId = new Map(signals.map(signal => [signal.id, signal]));
  const named = [...new Set(ids.filter(id => typeof id === "string").map(id => id.trim()))];
  return named
    .filter(id => byId.has(id) && strongestBeta(byId.get(id), symbols) > 0)
    .sort((a, b) => strongestBeta(byId.get(b), symbols) - strongestBeta(byId.get(a), symbols));
}

/**
 * The sentence added to a summary when it is served, from the odds at that moment:
 *   "Live Polymarket odds: China invades Taiwan 8% (▼2 pts this week)."
 * At most two markets. Empty when none of the ids is live any more.
 */
export function oddsLine(ids, signals) {
  const byId = new Map(signals.map(signal => [signal.id, signal]));
  const parts = (ids ?? [])
    .filter(id => byId.has(id))
    .slice(0, MAX_ODDS_MARKETS)
    .map(id => {
      const { label, price, change7d } = byId.get(id);
      const points = change7d === null ? null : Math.round(change7d * 100);
      const move = points === null ? "" : points === 0 ? " (flat this week)" : ` (${points > 0 ? "▲" : "▼"}${Math.abs(points)} ${Math.abs(points) === 1 ? "pt" : "pts"} this week)`;
      return `${label} ${percent(price)}${move}`;
    });
  return parts.length ? `Live Polymarket odds: ${parts.join(", ")}.` : "";
}
