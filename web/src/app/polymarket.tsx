// The test console's Polymarket section: how the weights moved and the markets behind it.
// Data: POST /api/weights.
import { driverOf, weekMove, yesNo, type Evidence } from "./consoleView";

export type Weights = {
  status: string;
  holdings: { symbol: string; weightPct: number }[];
  explanation: string;
  evidence: Evidence[];
};

const MOVE_TONE = { up: "text-up", down: "text-down", flat: "text-muted", none: "text-muted" };

/** One market: the question, Yes against No, this week's move and the stocks it touches. */
function MarketCard({ market }: { market: Evidence }) {
  const { yes, no } = yesNo(market.probability);
  const move = weekMove(market.change7d);
  return (
    <li className="grid content-start gap-2 rounded-xl border border-line p-3">
      <a
        className="font-medium text-blue hover:underline"
        href={market.url}
        target="_blank"
        rel="noreferrer"
      >
        {market.title}
      </a>
      <div>
        <div className="flex justify-between font-mono text-sm font-semibold">
          <span>YES {yes}%</span>
          <span className="text-muted">NO {no}%</span>
        </div>
        <div
          className="mt-1 flex h-3 overflow-hidden rounded-full bg-line"
          role="img"
          aria-label={`Yes ${yes}%, No ${no}%`}
        >
          <div className="bg-blue" style={{ width: `${yes}%` }} />
        </div>
      </div>
      <p className={`font-mono text-sm ${MOVE_TONE[move.direction]}`}>{move.text}</p>
      {market.symbols && market.symbols.length > 0 && (
        <ul className="flex flex-wrap gap-1.5" aria-label="Affected stocks">
          {market.symbols.map((symbol) => (
            <li
              key={symbol}
              className="rounded-full bg-blue-soft px-2.5 py-0.5 font-mono text-xs font-medium text-blue"
            >
              {symbol}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}

export function PolymarketSection({
  weights,
  start,
}: {
  weights: Weights;
  start: { symbol: string; weightPct: number }[];
}) {
  return (
    <div className="grid gap-4 text-sm">
      <div className="overflow-x-auto">
        <table className="w-full text-left">
          <thead className="text-xs tracking-wide text-muted">
            <tr>
              <th className="py-1 pr-3 font-medium">STOCK</th>
              <th className="py-1 pr-3 text-right font-medium">START</th>
              <th className="py-1 pr-3 text-right font-medium">NOW</th>
              <th className="py-1 font-medium">DRIVEN BY</th>
            </tr>
          </thead>
          <tbody>
            {weights.holdings.map((holding) => {
              const before = start.find((s) => s.symbol === holding.symbol)?.weightPct ?? 0;
              const delta = holding.weightPct - before;
              const driver = driverOf(holding.symbol, weights.evidence);
              const move = driver ? weekMove(driver.change7d) : null;
              return (
                <tr key={holding.symbol} className="border-t border-line align-top">
                  <td className="py-1.5 pr-3 font-mono font-semibold">{holding.symbol}</td>
                  <td className="py-1.5 pr-3 text-right font-mono whitespace-nowrap">
                    {before.toFixed(2)}%
                  </td>
                  <td
                    className={`py-1.5 pr-3 text-right font-mono font-semibold whitespace-nowrap ${delta > 0.004 ? "text-up" : delta < -0.004 ? "text-down" : ""}`}
                  >
                    {holding.weightPct.toFixed(2)}%
                  </td>
                  <td className="py-1.5">
                    {driver && move ? (
                      <>
                        {driver.title}
                        <span className={`block font-mono ${MOVE_TONE[move.direction]}`}>
                          {move.text}
                        </span>
                      </>
                    ) : (
                      <span className="text-muted">no linked market</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {weights.evidence.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {weights.evidence.map((market) => (
            <MarketCard key={market.url + market.title} market={market} />
          ))}
        </ul>
      ) : (
        <p className="text-muted">No live Polymarket market is linked to these stocks.</p>
      )}
      <p className="text-xs text-muted">Event probabilities indicate risk, not expected returns.</p>
    </div>
  );
}
