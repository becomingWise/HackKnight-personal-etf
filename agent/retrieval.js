// Retrieval: picks the parts of project-notes.json that matter for one idea. No network and no
// model call: sectors and context notes are scored by the keywords the idea contains.
import notes from "./project-notes.json" with { type: "json" };

export const NOTES = notes;

/** Every allowed ticker, in the order of the notes: { symbol, name, kind, sector }. */
export const ALLOWED = notes.sectors.flatMap(sector =>
  sector.tickers.map(ticker => ({ ...ticker, sector: sector.name }))
);
export const ALLOWED_BY_SYMBOL = new Map(ALLOWED.map(ticker => [ticker.symbol, ticker]));

function hasKeyword(text, keyword) {
  // Latin keywords need word boundaries ("ai" must not match "rain"); CJK matches anywhere.
  if (/[^\p{Script=Latin}\s.-]/u.test(keyword)) return text.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

function score(text, entry, names = []) {
  const keywords = entry.keywords.filter(keyword => hasKeyword(text, keyword)).length;
  // A company or ticker named in the idea counts like two keywords.
  const named = names.filter(name => hasKeyword(text, name.toLocaleLowerCase())).length;
  return keywords + 2 * named;
}

/**
 * The notes relevant to an idea.
 * @param {string} idea
 * @returns {{ rules: string[], context: string[], sectors: object[], otherSectors: object[], matched: boolean }}
 *   sectors: the ones the idea touches, best first (all of them when nothing matches);
 *   otherSectors: the rest, so the agent still sees every allowed ticker.
 */
export function retrieve(idea) {
  const text = String(idea ?? "").normalize("NFKC").toLocaleLowerCase();
  const ranked = notes.sectors
    .map((sector, index) => ({
      sector,
      index,
      score: score(text, sector, sector.tickers.flatMap(t => [t.symbol, t.name]))
    }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  const hits = ranked.filter(entry => entry.score > 0);
  const matched = hits.length > 0;
  const context = notes.context
    // Notes without keywords always apply; the others only when the idea mentions them.
    .filter(note => !note.keywords.length || score(text, note) > 0)
    .map(note => note.text);
  return {
    rules: [...notes.outputRules],
    context,
    sectors: (matched ? hits : ranked).map(entry => entry.sector),
    otherSectors: matched ? ranked.filter(entry => entry.score === 0).map(entry => entry.sector) : [],
    matched
  };
}

const tickerLine = sector =>
  `${sector.name} (${sector.about}) ` +
  sector.tickers.map(t => `${t.symbol} = ${t.name}${t.kind === "fund" ? " [fund]" : ""}`).join("; ");

/** The retrieved notes as the text block given to the model. */
export function notesForPrompt(idea) {
  const found = retrieve(idea);
  return [
    `PROJECT\n${notes.project}`,
    `NOTES\n${found.context.map(line => `- ${line}`).join("\n")}`,
    `OUTPUT RULES\n${found.rules.map(line => `- ${line}`).join("\n")}`,
    found.matched
      ? `SECTORS THIS IDEA TOUCHES (best match first)\n${found.sectors.map(tickerLine).join("\n")}`
      : `NO SECTOR MATCHED THE IDEA BY KEYWORD. ALL ALLOWED TICKERS\n${found.sectors.map(tickerLine).join("\n")}`,
    found.otherSectors.length
      ? `OTHER ALLOWED TICKERS\n${found.otherSectors.map(tickerLine).join("\n")}`
      : ""
  ].filter(Boolean).join("\n\n");
}
