import { ALLOWED, NOTES, retrieve } from "../agent/retrieval.js";
import { withPreference, withBasket, MAX_PREFERENCES, MAX_PREFERENCE_LENGTH } from "../agent/memory.js";

export function cleanPreferences(value = []) {
  if (!Array.isArray(value) || value.length > MAX_PREFERENCES || value.some(v => typeof v !== "string" || !v.trim() || v.length > MAX_PREFERENCE_LENGTH))
    throw new Error("Preferences must be up to ten short statements.");
  return [...new Set(value.map(v => v.replace(/\s+/g, " ").trim()))];
}

// Explicit sector/ticker exclusions are enforced in code in both example and live modes.
// Other lasting wishes saved by Gemini remain in the prompt as preferences.
const exclusion = /\b(?:exclude|avoid|without|no|never include|do not include|don't include)\s+([^,;.\n]+)|(?:不要|排除|不包含|不买)\s*([^，。；\n]+)/giu;
const oil = ["XOM", "CVX", "COP", "OXY", "SLB"];
const positiveClause = /\b(?:and|but|then)\s+(?:(?:I|we)\s+)?(?:invest|focus|prefer|include|buy|choose|want|add)\b|(?:但我|但是|我要)/i;
const excludedPhrase = phrase => phrase.split(positiveClause)[0].trim();
export function excludedSymbols(preferences) {
  const symbols = new Set();
  for (const preference of preferences) {
    for (const match of preference.matchAll(exclusion)) {
      const phrase = excludedPhrase(match[1] ?? match[2]);
      const found = retrieve(phrase);
      for (const stock of ALLOWED.filter(t => t.kind === "company")) {
        const named = new RegExp(`\\b${stock.symbol}\\b`, "i").test(phrase) || phrase.toLowerCase().includes(stock.name.toLowerCase());
        if (named) symbols.add(stock.symbol);
      }
      // A named company excludes that company, rather than every company in its sector.
      if ([...symbols].some(symbol => new RegExp(`\\b${symbol}\\b`, "i").test(phrase)) || ALLOWED.some(s => phrase.toLowerCase().includes(s.name.toLowerCase()))) continue;
      if (/\b(?:oil|petroleum)\b|石油/i.test(phrase) && !/\benergy\b|能源/i.test(phrase)) { oil.forEach(s => symbols.add(s)); continue; }
      if (found.matched) found.sectors.forEach(s => s.tickers.filter(t => t.kind === "company").forEach(t => symbols.add(t.symbol)));
      // Sector names such as Financials are useful when the preference came from Gemini.
      NOTES.sectors.filter(s => phrase.toLowerCase().includes(s.name.toLowerCase())).forEach(s => s.tickers.filter(t => t.kind === "company").forEach(t => symbols.add(t.symbol)));
    }
  }
  return symbols;
}

export function addExplicitPreferences(preferences, idea) {
  let record = { preferences, baskets: [] };
  for (const match of idea.matchAll(exclusion)) {
    const phrase = excludedPhrase(match[1] ?? match[2]);
    // Only retain a recognised exclusion; a phrase such as "no idea" is not a preference.
    const text = `Exclude ${phrase}`;
    if (excludedSymbols([text]).size) record = withPreference(record, text);
  }
  return record.preferences;
}

export const ideaTheme = idea => idea.replace(exclusion, (full, latin, chinese) => {
  const phrase = latin ?? chinese, index = phrase.search(positiveClause);
  return index < 0 ? " " : ` ${phrase.slice(index)} `;
}).replace(/[,;.，。；]+/g, " ").trim();
export function supportsTheme(idea, preferences = []) {
  const blocked = excludedSymbols(preferences), theme = ideaTheme(idea);
  const named = ALLOWED.filter(s => s.kind === "company" && (new RegExp(`\\b${s.symbol}\\b`, "i").test(theme) || theme.toLowerCase().includes(s.name.toLowerCase())));
  if (named.length) return named.some(s => !blocked.has(s.symbol));
  if (/\boil\b|石油/i.test(theme) && !/\benergy\b|能源/i.test(theme)) return oil.some(s => !blocked.has(s));
  const found = retrieve(theme);
  return found.matched && found.sectors.some(s => s.tickers.some(t => t.kind === "company" && !blocked.has(t.symbol)));
}
export function validatePreferences(stocks, preferences) {
  const blocked = excludedSymbols(preferences);
  const invalid = stocks.filter(s => blocked.has(s.symbol)).map(s => s.symbol);
  return invalid.length ? [`Saved preferences exclude ${invalid.join(", ")}. Choose other allowed companies.`] : [];
}

/** Browser preferences can restore this local process after a restart. No database is used. */
export function createSessionMemory() {
  const sessions = new Map();
  const read = id => sessions.get(id) ?? { preferences: [], baskets: [] };
  return {
    async load(id) { return structuredClone(read(id)); },
    async replacePreferences(id, preferences) { sessions.set(id, { ...read(id), preferences: cleanPreferences(preferences) }); },
    async rememberPreference(id, preference) { sessions.set(id, withPreference(read(id), preference)); },
    async rememberBasket(id, basket) { sessions.set(id, withBasket(read(id), structuredClone(basket))); },
  };
}
