// Live adjustWeights adapter. Implements the "Percentage adjustment port" in
// docs/team-contracts.md against the deployed backend: POST {baseUrl}/api/weights.
// Not wired into the app: import it where the controller is created (see web/docs/API.md).

export const DEFAULT_WEIGHTS_API = "https://prophetf.vercel.app";

/**
 * @param {{ baseUrl?: string, fetch?: typeof fetch }} [options]
 *   baseUrl: backend origin without a trailing path, e.g. "http://localhost:3000" in development,
 *   or "http://127.0.0.1:8001" for the Python service in /backend.
 * @returns {(input: { idea: string, holdings: { symbol: string, weightPct: number }[] },
 *   options?: { signal?: AbortSignal }) => Promise<{
 *     status: "adjusted" | "unchanged",
 *     holdings: { symbol: string, weightPct: number }[],
 *     explanation: string,
 *     evidence: { title: string, url: string, outcome: string, probability: number, observedAt: string }[]
 *   }>}
 */
export function createAdjustWeights({ baseUrl = DEFAULT_WEIGHTS_API, fetch: fetchFn = globalThis.fetch } = {}) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/weights`;
  return async function adjustWeights({ idea, holdings }, { signal } = {}) {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idea, holdings }),
      signal
    });
    // Rejects on HTTP errors and invalid JSON; the controller then keeps the starting weights.
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error?.message ?? detail?.detail ?? `Weighting service failed (${response.status}).`);
    }
    return response.json();
  };
}

/** Ready-to-use adapter pointing at the deployed backend. */
export const adjustWeights = createAdjustWeights();
