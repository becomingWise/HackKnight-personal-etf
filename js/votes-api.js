// Browser adapter for the AI voting panel: POST {API_BASE_URL}/api/votes.
//   getVotes({ idea, stocks }, { signal } = {})
// `stocks` is what findStocks returned ([{ symbol, name }]). Resolves to
//   { stocks: [{ symbol, name, yes, no, votes: [{ agent, vote, reason }] }], summary }
// where vote is "yes", "no" or "none" (that agent gave no answer). It rejects on any non-2xx
// status, on invalid JSON and on a malformed body, and never makes up votes.

/**
 * @param {{ baseUrl?: string, fetch?: typeof fetch }} [options]
 *   baseUrl: backend origin, e.g. "https://prophetf.vercel.app". Default: API_BASE_URL from ./config.js.
 */
export function createGetVotes({ baseUrl, fetch: fetchFn } = {}) {
  return async function getVotes({ idea, stocks }, { signal } = {}) {
    const base = baseUrl ?? (await import("./config.js")).API_BASE_URL;
    if (typeof base !== "string" || !base) throw new Error("js/config.js must export API_BASE_URL.");
    const response = await (fetchFn ?? globalThis.fetch)(`${base.replace(/\/+$/, "")}/api/votes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, stocks: stocks.map(({ symbol, name }) => ({ symbol, name })) }),
      signal
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error?.message ?? `The voting service failed (${response.status}).`);
    }
    // Invalid JSON rejects here.
    const data = await response.json();
    if (typeof data?.summary !== "string" || !Array.isArray(data.stocks)) {
      throw new Error("The voting service returned an invalid response.");
    }
    return data;
  };
}

/** Ready to use: calls the backend named in ./config.js. */
export const getVotes = createGetVotes();
