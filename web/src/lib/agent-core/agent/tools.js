// The agent's function tools: declarations for Gemini, argument checks, and execution.
// Google Search grounding is the google_search tool: it runs as a separate grounded Gemini call
// (see groundedSearch in gemini.js), because built-in tools cannot yet be mixed with function
// tools on every model we may use.
import { ALLOWED, ALLOWED_BY_SYMBOL } from "./retrieval.js";
import { MAX_PREFERENCE_LENGTH } from "./memory.js";

export const BASKET_SIZE = 3;

/**
 * The one rule set for a selection, used by the check_selection tool and again on the final
 * answer. Returns the canonical stocks when it passes.
 * @param {unknown} symbols
 * @returns {{ ok: true, stocks: { symbol: string, name: string }[] } | { ok: false, errors: string[] }}
 */
export function checkSelection(symbols, { min = BASKET_SIZE, max = BASKET_SIZE, companiesOnly = false } = {}) {
  if (!Array.isArray(symbols) || symbols.some(symbol => typeof symbol !== "string")) {
    return { ok: false, errors: ["symbols must be an array of ticker strings."] };
  }
  const cleaned = symbols.map(symbol => symbol.trim().toUpperCase());
  const errors = [];
  if (cleaned.length < min || cleaned.length > max) {
    errors.push(`Choose ${min === max ? `exactly ${min}` : `${min} to ${max}`} symbols; you gave ${cleaned.length}.`);
  }
  const repeated = [...new Set(cleaned.filter((symbol, index) => cleaned.indexOf(symbol) !== index))];
  if (repeated.length) errors.push(`Symbols must be unique; repeated: ${repeated.join(", ")}.`);
  const unknown = [...new Set(cleaned.filter(symbol => !ALLOWED_BY_SYMBOL.has(symbol)))];
  if (unknown.length) {
    errors.push(`Not in the allowed list: ${unknown.join(", ")}. Allowed: ${ALLOWED.map(t => t.symbol).join(", ")}.`);
  }
  if (companiesOnly && cleaned.some(symbol => ALLOWED_BY_SYMBOL.get(symbol)?.kind === "fund")) {
    errors.push("This shortlist accepts company stocks only, not funds.");
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    stocks: cleaned.map(symbol => ({ symbol, name: ALLOWED_BY_SYMBOL.get(symbol).name }))
  };
}

const DECLARATIONS = {
  check_selection: {
    name: "check_selection",
    description:
      "Checks a proposed basket: exactly 3 symbols, all different, all from the allowed list. Call it before giving the final answer and fix any errors it reports.",
    parameters: {
      type: "OBJECT",
      properties: {
        symbols: { type: "ARRAY", items: { type: "STRING" }, description: "The 3 ticker symbols, e.g. [\"NVDA\", \"TSM\", \"AMD\"]." }
      },
      required: ["symbols"]
    }
  },
  get_memory: {
    name: "get_memory",
    description:
      "Returns what is remembered for this session: the person's saved preferences and the baskets they were given before.",
    parameters: { type: "OBJECT", properties: {} }
  },
  remember_preference: {
    name: "remember_preference",
    description:
      "Saves a lasting preference the person stated about their portfolio (for example \"no oil companies\" or \"prefers large companies\"). Do not save the idea itself.",
    parameters: {
      type: "OBJECT",
      properties: {
        preference: { type: "STRING", description: "One short sentence, at most 200 characters." }
      },
      required: ["preference"]
    }
  },
  google_search: {
    name: "google_search",
    description:
      "Looks something up with Google Search and returns a short answer with sources. Use it at most once, and only when the idea depends on recent news or a name you do not recognise.",
    parameters: {
      type: "OBJECT",
      properties: { query: { type: "STRING", description: "A short search query." } },
      required: ["query"]
    }
  }
};

/** The declarations to send to Gemini. Tools that cannot run this turn are left out. */
export function functionDeclarations({ memory = true, search = true, selection = {} } = {}) {
  const { min = BASKET_SIZE, max = BASKET_SIZE } = selection;
  const check = structuredClone(DECLARATIONS.check_selection);
  if (min !== BASKET_SIZE || max !== BASKET_SIZE) {
    check.description = `Checks a shortlist: ${min} to ${max} unique company symbols, all from the allowed list. Call before answering and fix any errors.`;
    check.parameters.properties.symbols.description = `${min} to ${max} candidate ticker symbols. The user chooses which to add later.`;
  }
  return [
    check,
    ...(memory ? [DECLARATIONS.get_memory, DECLARATIONS.remember_preference] : []),
    ...(search ? [DECLARATIONS.google_search] : [])
  ];
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Runs one tool call. Bad arguments and unknown tools come back as { error } so the model can
 * correct itself; nothing here throws for the model's mistakes.
 * @param {string} name
 * @param {unknown} args
 * @param {{ sessionId: string | null, memory: object, search?: (query: string) => Promise<object> }} context
 */
export async function executeTool(name, args, context) {
  const input = isObject(args) ? args : {};
  switch (name) {
    case "check_selection":
      return checkSelection(input.symbols, context.selection);

    case "get_memory": {
      if (!context.sessionId) return { preferences: [], previousBaskets: [], note: "No session: nothing is remembered." };
      const record = await context.memory.load(context.sessionId);
      return {
        preferences: record.preferences,
        previousBaskets: record.baskets.map(({ idea, symbols }) => ({ idea, symbols }))
      };
    }

    case "remember_preference": {
      const preference = typeof input.preference === "string" ? input.preference.replace(/\s+/g, " ").trim() : "";
      if (!preference) return { error: "preference must be a non-empty string." };
      if (preference.length > MAX_PREFERENCE_LENGTH) {
        return { error: `preference must be at most ${MAX_PREFERENCE_LENGTH} characters.` };
      }
      if (!context.sessionId) return { saved: false, note: "No session: preferences are not kept." };
      await context.memory.rememberPreference(context.sessionId, preference);
      return { saved: true };
    }

    case "google_search": {
      const query = typeof input.query === "string" ? input.query.replace(/\s+/g, " ").trim() : "";
      if (!query) return { error: "query must be a non-empty string." };
      if (query.length > 200) return { error: "query must be at most 200 characters." };
      if (!context.search) return { available: false, note: "Search is not available; decide from the notes." };
      return context.search(query);
    }

    default:
      return { error: `Unknown tool "${name}".` };
  }
}
