// A free check before any Gemini call: is the text plainly not an idea? It is deliberately
// narrow. It flags only text with no letters or digits ("???"), one character repeated ("aaaa")
// or a keyboard run ("asdf", "qwerty"). Everything else, however short or odd, goes to the agent:
// tickers (TSM, NVDA), "AI", "oil", "Taiwan" and text in any language are never flagged.
//
// When it flags, the person is offered example ideas instead: one fixed idea per Polymarket
// signal the weighting service tracks, the ones whose odds moved most this week first.

/** One idea per tracked signal; each can be built from the allowed tickers. */
export const SIGNAL_IDEAS = {
  taiwan: "AI chips and Taiwan risk",
  no_cuts: "Banks if interest rates stay high",
  recession: "Bonds as a safe haven in a recession",
  hormuz_normal: "Oil majors and Strait of Hormuz shipping",
  bab_closed: "Oil and Red Sea shipping risk",
  iran_deal: "Oil prices after a US-Iran deal",
  ukraine_ceasefire: "Defense stocks and a Ukraine ceasefire",
  btc_100k: "Bitcoin reaching $100k",
  chip_export_law: "AI chip export rules",
  openai_1t: "Big Tech and an OpenAI IPO",
  ai_safety_bill: "AI regulation and Big Tech"
};

/** Offered when the live signals cannot be read. */
export const FIXED_EXAMPLES = [SIGNAL_IDEAS.taiwan, SIGNAL_IDEAS.btc_100k, SIGNAL_IDEAS.no_cuts];
export const EXAMPLE_COUNT = 3;
export const NONSENSE_QUESTION = "I could not read that as an investing idea. Would one of these work?";

const KEYBOARD_ROWS = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const reversed = text => [...text].reverse().join("");

/** "asdf", "qwerty", "zxcvbn", "lkjh": letters that sit next to each other on one keyboard row. */
function isKeyboardRun(word) {
  if (word.length < 4) return false;
  return KEYBOARD_ROWS.some((row, index) => {
    const forward = row.includes(word);
    if (!forward && !reversed(row).includes(word)) return false;
    // The top row holds real words ("wert" is German for value), so a short run must start
    // where a hand rests: at the q.
    if (index === 0 && word.length < 5) return forward && word.startsWith("q");
    return true;
  });
}

/**
 * True only for text that is plainly not an idea. Conservative on purpose: a false "nonsense"
 * would stop a real idea without asking the model.
 * @param {string} text
 */
export function looksLikeNonsense(text) {
  const trimmed = String(text ?? "").normalize("NFKC").trim();
  // Nothing to read: "???", "!!", "…", an emoji.
  if (!/[\p{L}\p{N}]/u.test(trimmed)) return true;
  // From here on only plain Latin letters and digits are judged; any other script is an idea.
  if (!/^[\x20-\x7E]+$/.test(trimmed)) return false;
  const words = trimmed.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!words.length) return true;
  // One character repeated: "aaaa", "zzz zzz", "1111".
  const letters = words.join("");
  if (letters.length >= 3 && new Set(letters).size === 1) return true;
  return words.every(isKeyboardRun);
}

/**
 * Example ideas to offer: the tracked signals with the largest 7-day odds move first.
 * @param {{ id: string, change7d: number | null }[]} signals  usableSignals(...) of signals.js
 * @returns {string[]} exactly EXAMPLE_COUNT ideas
 */
export function exampleIdeas(signals) {
  const moved = (signals ?? [])
    .filter(signal => SIGNAL_IDEAS[signal.id])
    .sort((a, b) => Math.abs(b.change7d ?? 0) - Math.abs(a.change7d ?? 0))
    .map(signal => SIGNAL_IDEAS[signal.id]);
  if (!moved.length) return [...FIXED_EXAMPLES];
  // Fewer than three live signals: the fixed examples fill the rest.
  return [...new Set([...moved, ...FIXED_EXAMPLES])].slice(0, EXAMPLE_COUNT);
}
