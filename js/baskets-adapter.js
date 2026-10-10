// Saved-basket adapter for the deployed backend: save and open baskets, and load the odds
// history of the markets they cite (POST /api/baskets, GET /api/baskets/{id}, .../odds,
// GET /api/markets/{id}/history).
// Not wired into the app: import it where a basket is saved or opened (see web/docs/API.md).

export const DEFAULT_BASKETS_API = "https://prophetf.vercel.app";

async function parse(response, fallback) {
  if (!response.ok) {
    const detail = await response.json().catch(() => null);
    throw new Error(detail?.error?.message ?? `${fallback} (${response.status}).`);
  }
  return response.json();
}

/**
 * Maps a controller snapshot (controller.getState() with status "ready") to the save request.
 * A basket whose weight adjustment was unavailable is saved with its starting weights.
 */
export function basketFromState(state) {
  const adjusted = ["adjusted", "unchanged"].includes(state.adjustment?.status);
  return {
    idea: state.idea,
    stocks: { summary: state.summary, stocks: state.stocks },
    weights: {
      status: adjusted ? state.adjustment.status : "unavailable",
      holdings: state.holdings,
      explanation: state.adjustment?.explanation ?? "",
      evidence: adjusted ? state.adjustment.evidence : []
    }
  };
}

/**
 * @param {{ baseUrl?: string, fetch?: typeof fetch }} [options]
 *   baseUrl: backend origin without a trailing path, e.g. "http://localhost:3000" in development.
 */
export function createBaskets({ baseUrl = DEFAULT_BASKETS_API, fetch: fetchFn = globalThis.fetch } = {}) {
  const api = `${baseUrl.replace(/\/+$/, "")}/api`;
  const root = `${api}/baskets`;
  return {
    /**
     * Saves a basket. Pass the /api/stocks and /api/weights responses as they are:
     *   saveBasket({ idea, stocks: stocksResponse, weights: weightsResponse })
     * or a controller snapshot: saveBasket(basketFromState(controller.getState())).
     * Resolves to the saved basket; `id` is the short id and `url` the link to share.
     */
    async saveBasket({ idea, stocks, weights = null }, { signal } = {}) {
      const response = await fetchFn(root, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idea, stocks, weights }),
        signal
      });
      return parse(response, "The basket could not be saved");
    },

    /** Loads a saved basket by its short id. Rejects when it does not exist. */
    async getBasket(id, { signal } = {}) {
      const response = await fetchFn(`${root}/${encodeURIComponent(id)}`, { signal });
      return parse(response, "The basket could not be loaded");
    },

    /**
     * Odds history of every market the basket cites, for a chart. range: "1d" | "7d" | "30d".
     * Resolves to { markets: [{ id, title, probabilityAtCreation, current, points: [{ t, p }] }], ... }.
     */
    async getBasketOdds(id, range = "7d", { signal } = {}) {
      const url = `${root}/${encodeURIComponent(id)}/odds?range=${encodeURIComponent(range)}`;
      return parse(await fetchFn(url, { signal }), "The odds history could not be loaded");
    },

    /** Odds history of one Polymarket market (a marketId). range: "1d" | "7d" | "30d". */
    async getMarketHistory(marketId, range = "7d", { signal } = {}) {
      const url = `${api}/markets/${encodeURIComponent(marketId)}/history?range=${encodeURIComponent(range)}`;
      return parse(await fetchFn(url, { signal }), "The odds history could not be loaded");
    }
  };
}

/** Ready-to-use functions pointing at the deployed backend. */
export const { saveBasket, getBasket, getBasketOdds, getMarketHistory } = createBaskets();
