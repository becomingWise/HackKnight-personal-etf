"use client";

// The test console's track record: is the AI panel right? Data: GET /api/track-record.
import { useState } from "react";
import {
  agentsByPct,
  panelSaid,
  paperResult,
  resultOf,
  rightText,
  scopeText,
  verdict,
  versusMarket,
  type Decision,
  type TrackRecord,
} from "./consoleView";

const SHOWN_FIRST = 10;
const TONE = { up: "text-up", down: "text-down", muted: "text-muted" } as const;

/** One horizontal bar on a 0 to 100% scale, with a line at 50%. */
function Bar(props: { name: string; pct: number | null; text: string; fill: string }) {
  const width = Math.min(100, Math.max(0, props.pct ?? 0));
  return (
    <li className="grid gap-1">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <span className="font-medium">{props.name}</span>
        <span className="font-mono text-sm">{props.text}</span>
      </div>
      <div
        className="relative h-3 rounded-full bg-line"
        role="img"
        aria-label={`${props.name}: ${props.text}`}
      >
        <div className={`h-full rounded-full ${props.fill}`} style={{ width: `${width}%` }} />
        {/* The 50% reference line. */}
        <div aria-hidden="true" className="absolute -top-1 -bottom-1 left-1/2 w-0.5 bg-ink" />
      </div>
    </li>
  );
}

function Scale() {
  return (
    <div aria-hidden="true" className="relative h-4 font-mono text-xs text-muted">
      <span className="absolute left-0">0%</span>
      <span className="absolute left-1/2 -translate-x-1/2">50%</span>
      <span className="absolute right-0">100%</span>
    </div>
  );
}

function DecisionRow({ row }: { row: Decision }) {
  const said = panelSaid(row);
  const versus = versusMarket(row);
  const paper = paperResult(row);
  const result = resultOf(row);
  // On a phone each row is a small card with its labels; from sm up it is a table row.
  const label = "text-xs text-muted sm:hidden";
  return (
    <li className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-xl border border-line p-3 sm:grid-cols-[6.5rem_1.5fr_1fr_7.5rem_8rem_5rem] sm:items-baseline sm:rounded-none sm:border-0 sm:border-t sm:px-0 sm:py-2">
      <div>
        <p className={label}>Week of</p>
        <p className="font-mono whitespace-nowrap">{row.date}</p>
        {row.source === "live" && <p className="text-xs text-blue">live</p>}
      </div>
      <div>
        <p className={label}>Idea</p>
        <p>{row.idea}</p>
      </div>
      <div>
        <p className={label}>Stocks</p>
        <p className="font-mono">{row.symbols.join(" ")}</p>
      </div>
      <div>
        <p className={label}>Panel said</p>
        <p className={said.invest ? "font-medium text-blue" : "font-medium"}>{said.label}</p>
      </div>
      <div>
        <p className={label}>Basket vs S&amp;P 500</p>
        {versus ? (
          <p
            className={`font-mono ${versus.points > 0 ? "text-up" : versus.points < 0 ? "text-down" : ""}`}
            title={versus.detail}
          >
            {versus.text}
          </p>
        ) : (
          <p className="text-muted">week not over</p>
        )}
        {paper && <p className="text-xs text-muted">{paper}</p>}
      </div>
      <div>
        <p className={label}>Result</p>
        <p className={`font-medium whitespace-nowrap ${TONE[result.tone]}`}>{result.text}</p>
      </div>
    </li>
  );
}

export function TrackRecordSection({ track }: { track: TrackRecord }) {
  const [all, setAll] = useState(false);
  const agents = agentsByPct(track.agents);
  const coin = track.baselines.coinFlip;
  const rows = all ? track.recent : track.recent.slice(0, SHOWN_FIRST);
  const panel = "rounded-panel border border-line bg-surface p-5";

  return (
    <div className="grid gap-5">
      <section className={panel}>
        <p className="text-xs font-semibold tracking-[0.18em] text-blue">3 · TRACK RECORD</p>
        <h2 className="mt-1 text-xl font-semibold">Is the AI panel right?</h2>
        <p className="mt-1 text-sm text-muted">
          {scopeText(track)} Each week five AI agents said whether a basket of three stocks would
          beat the S&amp;P 500 over the next seven days; the panel&apos;s answer is what at least 3
          of the 5 agreed on.
          {track.pending > 0 &&
            ` ${track.pending} more ${track.pending === 1 ? "is" : "are"} waiting for the week to pass.`}
        </p>
        <ul className="mt-4 grid gap-3">
          <Bar
            name="Panel (3 of 5)"
            pct={track.majority.pct}
            text={rightText(track.majority)}
            fill="bg-blue"
          />
          <Bar
            name="Coin flip"
            pct={coin.pct}
            text={`${coin.pct}% right (by definition)`}
            fill="bg-muted"
          />
          <Bar
            name="Always invest"
            pct={track.baselines.alwaysYes.pct}
            text={rightText(track.baselines.alwaysYes)}
            fill="bg-muted"
          />
        </ul>
        <div className="mt-1">
          <Scale />
        </div>
        <p className="mt-3 rounded-xl bg-blue-soft px-3 py-2 font-medium">{verdict(track)}</p>
      </section>

      <section className={panel}>
        <h3 className="text-lg font-semibold">Each agent</h3>
        <p className="mt-1 text-sm text-muted">
          Share of right calls, best first. The vertical line marks 50%, what a coin flip gets.
        </p>
        <ul className="mt-4 grid gap-3">
          {agents.map((agent) => (
            <Bar
              key={agent.id}
              name={agent.agent}
              pct={agent.pct}
              text={rightText(agent)}
              fill="bg-blue"
            />
          ))}
        </ul>
        <div className="mt-1">
          <Scale />
        </div>
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-medium text-blue">Details</summary>
          <div className="mt-3 grid gap-3">
            <p className="text-muted">
              <span className="font-medium text-ink">90% range:</span> where the share of right
              calls would probably land if the same weeks were drawn again. If it includes 50%, the
              agent cannot be told apart from a coin flip.
            </p>
            <p className="text-muted">
              <span className="font-medium text-ink">Brier score:</span> how good the stated
              probabilities were. 0 is perfect, 0.25 is a coin flip, lower is better.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full max-w-lg text-left">
                <thead className="text-xs tracking-wide text-muted">
                  <tr>
                    <th className="py-1 pr-3 font-medium">AGENT</th>
                    <th className="py-1 pr-3 text-right font-medium">90% RANGE</th>
                    <th className="py-1 text-right font-medium">BRIER</th>
                  </tr>
                </thead>
                <tbody className="font-mono">
                  {[
                    ...agents.map((a) => ({ name: a.agent, ...a })),
                    { name: "Panel (3 of 5)", ...track.majority },
                    { name: "Always invest", ...track.baselines.alwaysYes },
                  ].map((row) => (
                    <tr key={row.name} className="border-t border-line">
                      <td className="py-1 pr-3 font-sans">{row.name}</td>
                      <td className="py-1 pr-3 text-right whitespace-nowrap">
                        {row.range90 ? `${row.range90[0]}% to ${row.range90[1]}%` : "too few weeks"}
                      </td>
                      <td className="py-1 text-right">
                        {row.brier === null ? "none" : row.brier.toFixed(3)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </details>
      </section>

      <section className={panel}>
        <h3 className="text-lg font-semibold">Latest decisions</h3>
        <p className="mt-1 text-sm text-muted">
          Right means: the panel said Invest and the basket beat the S&amp;P 500 that week, or it
          said Skip and the basket did not. Prices loaded up to {track.lastClose ?? "unknown"}.
        </p>
        <div className="mt-3 text-sm">
          <div className="hidden grid-cols-[6.5rem_1.5fr_1fr_7.5rem_8rem_5rem] gap-x-4 pb-2 text-xs tracking-wide text-muted sm:grid">
            <span>WEEK OF</span>
            <span>IDEA</span>
            <span>STOCKS</span>
            <span>PANEL SAID</span>
            <span>BASKET VS S&amp;P 500</span>
            <span>RESULT</span>
          </div>
          <ul className="grid gap-2 sm:gap-0">
            {rows.map((row) => (
              <DecisionRow
                key={`${row.date}|${row.source}|${row.idea}|${row.symbols.join()}`}
                row={row}
              />
            ))}
          </ul>
        </div>
        {track.recent.length > SHOWN_FIRST && (
          <button
            type="button"
            onClick={() => setAll(!all)}
            className="mt-3 rounded-full border border-line px-4 py-1.5 text-sm font-medium hover:border-blue hover:text-blue"
          >
            {all ? `Show the latest ${SHOWN_FIRST}` : `Show all ${track.recent.length}`}
          </button>
        )}
        <p className="mt-3 text-xs text-muted">
          Paper results on past data. AI opinions, not financial advice.
        </p>
      </section>
    </div>
  );
}
