// Optional display basket for a selection: the three stocks with equal starting weights. The
// weights come from the shared controller's startingWeights, never from Gemini.
import { startingWeights } from "../js/controller.js";

/**
 * @param {{ summary: string, stocks: { symbol: string, name: string }[] }} selection
 * @returns {{ title: string, allocationMethod: "equal", holdings: { symbol: string, name: string, weightPct: number }[] }}
 */
export function buildBasket({ summary, stocks }) {
  const weights = startingWeights(stocks);
  return {
    title: summary,
    allocationMethod: "equal",
    holdings: stocks.map((stock, index) => ({
      symbol: stock.symbol,
      name: stock.name,
      weightPct: weights[index].weightPct
    }))
  };
}
