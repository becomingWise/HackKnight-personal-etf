// Session memory: the preferences a person stated and the baskets they were given, keyed by a
// session id. Locally the id is MYETF_SESSION_ID and the store lives in this process; the
// deployed backend passes a store with the same three methods backed by a Tiger table, and the
// browser sends its id in the X-Session-Id header.

export const MAX_PREFERENCES = 10;
export const MAX_BASKETS = 5;
export const MAX_PREFERENCE_LENGTH = 200;

/** A usable session id, or null. Anything else (missing, too long, odd characters) means "no session". */
export function cleanSessionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return /^[A-Za-z0-9_.:-]{1,64}$/.test(id) ? id : null;
}

const empty = () => ({ preferences: [], baskets: [] });

/** Adds a preference to a memory record: trimmed, de-duplicated, newest last, at most ten. */
export function withPreference(record, preference) {
  const text = String(preference).replace(/\s+/g, " ").trim().slice(0, MAX_PREFERENCE_LENGTH);
  if (!text) return record;
  const others = record.preferences.filter(item => item.toLocaleLowerCase() !== text.toLocaleLowerCase());
  return { ...record, preferences: [...others, text].slice(-MAX_PREFERENCES) };
}

/** Adds a basket { idea, summary, symbols, at } to a memory record, newest last, at most five. */
export function withBasket(record, basket) {
  return { ...record, baskets: [...record.baskets, basket].slice(-MAX_BASKETS) };
}

/**
 * The in-process store. Every method is async so a database-backed store can replace it.
 * @returns {{ load(sessionId): Promise<{preferences: string[], baskets: object[]}>,
 *   rememberPreference(sessionId, preference): Promise<void>,
 *   rememberBasket(sessionId, basket): Promise<void> }}
 */
export function createMemoryStore() {
  const sessions = new Map();
  const read = sessionId => sessions.get(sessionId) ?? empty();
  return {
    async load(sessionId) {
      return structuredClone(read(sessionId));
    },
    async rememberPreference(sessionId, preference) {
      sessions.set(sessionId, withPreference(read(sessionId), preference));
    },
    async rememberBasket(sessionId, basket) {
      sessions.set(sessionId, withBasket(read(sessionId), structuredClone(basket)));
    }
  };
}

/** The store shared by everything in this process (the CLI and the local server). */
export const localMemory = createMemoryStore();
