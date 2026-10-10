// Live event-risk adapter: POST {baseUrl}/api/risk (contract: web/docs/API.md section 2b).
// Same pattern as weights-adapter.js. Feed the result to renderEvidenceCards in evidence-cards.js.

import { DEFAULT_WEIGHTS_API } from "./weights-adapter.js";

/**
 * @param {{ baseUrl?: string, fetch?: typeof fetch }} [options]
 * @returns {(input: { holdings: { symbol: string, weightPct: number }[] },
 *   options?: { signal?: AbortSignal }) => Promise<{
 *     markets: { title: string, url: string, probability: number, observedAt: string,
 *       ifYesPct: number, ifNoPct: number, drivers: object[] }[],
 *     uncovered: string[], basis: string, note: string
 *   }>}
 */
export function createEventRisk({ baseUrl = DEFAULT_WEIGHTS_API, fetch: fetchFn = globalThis.fetch } = {}) {
  const url = `${baseUrl.replace(/\/+$/, "")}/api/risk`;
  return async function eventRisk({ holdings }, { signal } = {}) {
    const response = await fetchFn(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ holdings }),
      signal
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error?.message ?? `Event risk service failed (${response.status}).`);
    }
    return response.json();
  };
}

/** Ready-to-use adapter pointing at the deployed backend. */
export const eventRisk = createEventRisk();
