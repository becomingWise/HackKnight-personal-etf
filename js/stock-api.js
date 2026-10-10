// Browser findStocks adapter: POST {API_BASE_URL}/api/stocks (see TEAM_HANDOFF.md, Lucas section).
// Same signature as the server function: findStocks({ idea }, { signal } = {}) resolves to
// { summary, stocks: [{ symbol, name }] }. It rejects on any non-2xx status, on invalid JSON and
// on a malformed body, and never substitutes demo companies.
// The rejection is an Error that keeps the backend's `code`. When the idea needs clarifying
// (422, code "needs_clarification") its message is the question to show and `options` is an array
// of 2 or 3 ideas: offer them, and call findStocks again with the one the person picks.

const SESSION_KEY = "myetf.sessionId";
let fallbackSessionId;

const newId = () =>
  globalThis.crypto?.randomUUID?.() ?? `s-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

/** One id per browser tab (sessionStorage), so the agent's memory is not shared between tabs. */
export function tabSessionId() {
  try {
    const stored = globalThis.sessionStorage.getItem(SESSION_KEY);
    if (stored) return stored;
    const created = newId();
    globalThis.sessionStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    // No sessionStorage (private mode, Node): one id for the lifetime of this module.
    return (fallbackSessionId ??= newId());
  }
}

/**
 * @param {{ baseUrl?: string, fetch?: typeof fetch, sessionId?: () => string }} [options]
 *   baseUrl: backend origin, e.g. "https://prophetf.vercel.app". Default: API_BASE_URL from ./config.js.
 */
export function createFindStocks({ baseUrl, fetch: fetchFn, sessionId = tabSessionId } = {}) {
  return async function findStocks({ idea }, { signal } = {}) {
    const base = baseUrl ?? (await import("./config.js")).API_BASE_URL;
    if (typeof base !== "string" || !base) throw new Error("js/config.js must export API_BASE_URL.");
    const response = await (fetchFn ?? globalThis.fetch)(`${base.replace(/\/+$/, "")}/api/stocks`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Session-Id": sessionId() },
      body: JSON.stringify({ idea }),
      signal
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      const error = new Error(detail?.error?.message ?? `The stock service failed (${response.status}).`);
      if (typeof detail?.error?.code === "string") error.code = detail.error.code;
      if (Array.isArray(detail?.error?.options)) {
        error.options = detail.error.options.filter(option => typeof option === "string");
      }
      throw error;
    }
    // Invalid JSON rejects here.
    const data = await response.json();
    if (typeof data?.summary !== "string" || !Array.isArray(data.stocks)) {
      throw new Error("The stock service returned an invalid response.");
    }
    return data;
  };
}

/** Ready to use: calls the backend named in ./config.js. */
export const findStocks = createFindStocks();
