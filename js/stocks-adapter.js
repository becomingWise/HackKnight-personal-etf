// Live findStocks adapter (API teammate). Implements the "Stock selection port" in
// docs/team-contracts.md against the ProphETF backend: POST {baseUrl}/api/stocks.
// Not wired into the app: import it where the controller is created (see web/docs/API.md).

export const DEFAULT_STOCKS_API = "https://prophetf.vercel.app";

/**
 * @param {{ baseUrl?: string, fetch?: typeof fetch }} [options]
 *   baseUrl: backend origin without a trailing path, e.g. "http://localhost:3000" in development.
 * @returns {(input: { idea: string }, options?: { signal?: AbortSignal }) =>
 *   Promise<{ summary: string, stocks: { symbol: string, name: string, reason: string }[] }>}
 */
export function createFindStocks({ baseUrl = DEFAULT_STOCKS_API, fetch: fetchFn = globalThis.fetch } = {}) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/stocks`;
  return async function findStocks({ idea }, { signal } = {}) {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea }),
      signal
    });
    // Rejects on HTTP errors and invalid JSON; never substitutes demo data.
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error?.message ?? `Stock service failed (${response.status}).`);
    }
    const data = await response.json();
    return {
      summary: data.summary,
      stocks: data.stocks.map(({ symbol, name, reason }) => ({ symbol, name, reason }))
    };
  };
}

/** Ready-to-use adapter pointing at the deployed backend. */
export const findStocks = createFindStocks();
