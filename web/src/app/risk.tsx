// Event risk on the Build page: how far the basket would move if each linked Polymarket event
// happens, or does not. Data: POST /api/risk. Market titles are rendered as text.
import { yesNo } from "./consoleView";
import { movePct, moveTone, safeLink, type Risk } from "./productView";

const TONE = { up: "text-up", down: "text-down", muted: "text-muted" } as const;

export function RiskSection({ risk }: { risk: Risk }) {
  if (!risk.markets.length) {
    return (
      <p className="text-sm text-muted">
        No live Polymarket event is linked to these stocks, so there is no event scenario to show.
      </p>
    );
  }
  return (
    <div className="grid gap-3 text-sm">
      <ul className="grid gap-2">
        {risk.markets.map((market) => {
          const link = safeLink(market.url);
          return (
            <li
              key={market.url + market.title}
              className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[1fr_auto_auto] sm:items-center sm:gap-5"
            >
              <p>
                {link ? (
                  <a
                    className="font-medium text-blue hover:underline"
                    href={link}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {market.title}
                  </a>
                ) : (
                  <span className="font-medium">{market.title}</span>
                )}
                <span className="block text-xs text-muted">
                  Odds now: {yesNo(market.probability).yes}% yes · affects{" "}
                  {market.drivers.map((driver) => driver.symbol).join(", ")}
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-3 sm:block sm:text-right">
                <span className="text-xs text-muted sm:block">If yes</span>
                <span
                  className={`font-mono text-base font-semibold ${TONE[moveTone(market.ifYesPct)]}`}
                >
                  {movePct(market.ifYesPct)}
                </span>
              </p>
              <p className="flex items-baseline justify-between gap-3 sm:block sm:text-right">
                <span className="text-xs text-muted sm:block">If no</span>
                <span
                  className={`font-mono text-base font-semibold ${TONE[moveTone(market.ifNoPct)]}`}
                >
                  {movePct(market.ifNoPct)}
                </span>
              </p>
            </li>
          );
        })}
      </ul>
      {risk.uncovered.length > 0 && (
        <p className="text-muted">No measurable event exposure: {risk.uncovered.join(", ")}.</p>
      )}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer text-sm text-blue">How these numbers are made</summary>
        <p className="mt-2">
          The estimated move of the whole basket if the event happens (odds go to 100%) or does not
          (odds go to 0%).
        </p>
        <p className="mt-1">{risk.basis}</p>
        <p className="mt-1">{risk.note}</p>
      </details>
    </div>
  );
}
