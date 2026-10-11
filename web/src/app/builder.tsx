"use client";

// The Build page: an idea in, a basket out. It calls POST /api/stocks (the Gemini agent, which
// may ask instead of answering), then POST /api/votes and POST /api/weights together, then
// POST /api/risk for the tilted weights. Nothing is called until the visitor submits an idea.
import { useEffect, useRef, useState } from "react";
import { ApiFailure, asFailure, post } from "./client";
import { labBasketUrl } from "./consoleView";
import { PanelSection } from "./panel";
import { PolymarketSection } from "./polymarket";
import {
  EXAMPLE_IDEAS,
  basketRows,
  equalWeights,
  plainError,
  progressSteps,
  weightText,
  weightsNote,
  type Holding,
  type Phase,
  type Risk,
  type Stocks,
  type Votes,
  type Weights,
} from "./productView";
import { RiskSection } from "./risk";
import { SaveShare } from "./share";

/** A part of the result: still loading, there, or not available (said in plain words). */
type Part<T> =
  { state: "loading" } | { state: "ready"; data: T } | { state: "failed"; why: string };
const LOADING = { state: "loading" } as const;

type Result = {
  idea: string;
  stocks: Stocks;
  start: Holding[];
  weights: Part<Weights>;
  votes: Part<Votes>;
  risk: Part<Risk>;
};
type Clarify = { question: string; options: string[] };

const PANEL = "rounded-panel border border-line bg-surface p-5 sm:p-6";
const EYEBROW = "text-xs font-semibold tracking-[0.18em] text-blue";
const CHANGE_TONE = { up: "text-up", down: "text-down", flat: "text-muted" } as const;
/** The server reads the odds first (at most 3 s), then the agent picks. */
const ODDS_STEP_MS = 1500;

function Steps({ phase, oddsRead }: { phase: Phase; oddsRead: boolean }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-2 gap-y-2 text-sm" aria-label="Progress">
      {progressSteps(phase, oddsRead).map((step, index) => (
        <li key={step.label} className="flex items-center gap-2">
          {index > 0 && (
            <span aria-hidden="true" className="text-muted">
              →
            </span>
          )}
          <span
            className={
              step.state === "active"
                ? "rounded-full bg-blue-soft px-3 py-1 font-semibold text-blue"
                : step.state === "done"
                  ? "px-1 py-1 text-up"
                  : "px-1 py-1 text-muted"
            }
          >
            {step.state === "done" ? "✓ " : ""}
            {step.label}
            {step.state === "active" ? "…" : ""}
          </span>
        </li>
      ))}
    </ol>
  );
}

function Pending({ part, loading }: { part: { state: string; why?: string }; loading: string }) {
  return (
    <p className="text-sm text-muted" role="status">
      {part.state === "failed" ? part.why : loading}
    </p>
  );
}

export function Builder() {
  const [idea, setIdea] = useState("");
  const [phase, setPhase] = useState<Phase>("idle");
  const [oddsRead, setOddsRead] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const [clarify, setClarify] = useState<Clarify | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  /** Only the latest run may write to the page. */
  const runId = useRef(0);
  const busy = phase === "stocks" || phase === "panel";

  // A keyboard or screen-reader user lands on the basket when it arrives.
  const shownIdea = result?.idea;
  useEffect(() => {
    if (shownIdea) heading.current?.focus();
  }, [shownIdea]);

  async function run(text: string) {
    const wanted = text.trim();
    if (!wanted || busy) return;
    const id = ++runId.current;
    const current = () => id === runId.current;
    setIdea(wanted);
    setResult(null);
    setClarify(null);
    setProblem(null);
    setOddsRead(false);
    setPhase("stocks");
    const timer = setTimeout(() => current() && setOddsRead(true), ODDS_STEP_MS);

    let stocks: Stocks;
    try {
      stocks = await post<Stocks>("/api/stocks", { idea: wanted });
    } catch (err) {
      if (!current()) return;
      if (err instanceof ApiFailure && err.code === "needs_clarification" && err.options?.length) {
        setClarify({ question: err.message, options: err.options });
      } else {
        setProblem(plainError(asFailure(err), "that idea"));
      }
      setPhase("idle");
      return;
    } finally {
      clearTimeout(timer);
    }
    if (!current()) return;

    const start = equalWeights(stocks.stocks.map((stock) => stock.symbol));
    setResult({ idea: wanted, stocks, start, weights: LOADING, votes: LOADING, risk: LOADING });
    setPhase("panel");
    const update = (part: Partial<Result>) =>
      current() && setResult((shown) => (shown ? { ...shown, ...part } : shown));

    // The panel and the weights do not depend on each other; the risk uses the tilted weights.
    await Promise.all([
      post<Votes>("/api/votes", { idea: wanted, stocks: stocks.stocks }).then(
        (data) => update({ votes: { state: "ready", data } }),
        (err) =>
          update({
            votes: {
              state: "failed",
              why:
                asFailure(err).code === "ai_budget_used_up"
                  ? "The AI panel has used up its free quota for now. The basket above is not affected."
                  : "The AI panel is not available right now. The basket above is not affected.",
            },
          }),
      ),
      post<Weights>("/api/weights", { idea: wanted, holdings: start })
        .then(
          (data) => {
            update({ weights: { state: "ready", data } });
            return data.holdings;
          },
          () => {
            update({
              weights: {
                state: "failed",
                why: "The Polymarket odds could not be read right now, so the weights stay equal.",
              },
            });
            return start;
          },
        )
        .then((holdings) => post<Risk>("/api/risk", { holdings }))
        .then(
          (data) => update({ risk: { state: "ready", data } }),
          () =>
            update({
              risk: { state: "failed", why: "The event scenarios are not available right now." },
            }),
        ),
    ]);
    if (current()) setPhase("done");
  }

  function reset() {
    runId.current += 1;
    setResult(null);
    setClarify(null);
    setProblem(null);
    setPhase("idle");
    setIdea("");
    input.current?.focus();
    window.scrollTo({ top: 0 });
  }

  const tilted = result?.weights.state === "ready" ? result.weights.data : null;
  const rows = result
    ? basketRows(result.stocks.stocks, result.start, tilted?.holdings ?? null)
    : [];

  return (
    <div className="grid gap-5">
      <section className={PANEL}>
        <form
          className="flex flex-wrap gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(idea);
          }}
        >
          <label className="sr-only" htmlFor="idea">
            Your investing idea
          </label>
          <input
            id="idea"
            ref={input}
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            maxLength={500}
            autoComplete="off"
            placeholder="Your investing idea, for example: AI chips and Taiwan risk"
            className="min-w-0 flex-1 basis-64 rounded-xl border border-line bg-bg px-4 py-3 text-base"
          />
          <button
            type="submit"
            disabled={busy || !idea.trim()}
            className="rounded-xl bg-blue px-6 py-3 font-semibold text-surface disabled:opacity-50"
          >
            {busy ? "Working…" : "Build my basket"}
          </button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-sm text-muted">Try:</span>
          {EXAMPLE_IDEAS.map((example) => (
            <button
              key={example}
              type="button"
              disabled={busy}
              onClick={() => void run(example)}
              className="rounded-full border border-line px-3 py-1.5 text-left text-sm hover:border-blue hover:text-blue disabled:opacity-50"
            >
              {example}
            </button>
          ))}
        </div>

        <div className="mt-4" aria-live="polite">
          {busy && <Steps phase={phase} oddsRead={oddsRead} />}
          {problem && (
            <p role="alert" className="rounded-xl bg-down-soft px-4 py-3 text-sm text-down">
              {problem}
            </p>
          )}
          {clarify && (
            // The agent asks instead of answering: its question, and one button per idea it offers.
            <div className="grid gap-3 rounded-xl bg-blue-soft p-4">
              <p className="text-base font-semibold">{clarify.question}</p>
              <div className="flex flex-wrap gap-2">
                {clarify.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => void run(option)}
                    className="rounded-full border border-blue bg-surface px-4 py-2 text-left text-sm font-medium text-blue hover:bg-bg"
                  >
                    {option}
                  </button>
                ))}
              </div>
              <p className="text-sm text-muted">Pick one, or type a different idea above.</p>
            </div>
          )}
          {phase === "idle" && !problem && !clarify && (
            <p className="text-sm text-muted">
              You get three stocks, weights tilted by this week&apos;s Polymarket odds, and five AI
              agents&apos; votes. It takes about ten seconds.
            </p>
          )}
        </div>
      </section>

      {result && (
        <>
          <section className={PANEL} aria-labelledby="basket-title">
            <p className={EYEBROW}>YOUR BASKET</p>
            <h2
              id="basket-title"
              ref={heading}
              tabIndex={-1}
              className="mt-1 text-xl font-semibold outline-none"
            >
              {result.idea}
            </h2>
            <p className="mt-1 text-muted">{result.stocks.summary}</p>
            <ul className="mt-4 grid gap-3 sm:grid-cols-3">
              {rows.map((row) => (
                <li key={row.symbol} className="rounded-xl border border-line p-4">
                  <p className="flex items-baseline justify-between gap-2">
                    <strong className="font-mono text-lg">{row.symbol}</strong>
                    <span className="font-mono text-2xl font-semibold">
                      {weightText(row.weightPct)}
                    </span>
                  </p>
                  <p className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-muted">{row.name}</span>
                    {tilted && (
                      <span className={`font-mono ${CHANGE_TONE[row.direction]}`}>
                        {row.change}
                      </span>
                    )}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-muted">
              {weightsNote(tilted, result.weights.state === "failed")}
            </p>
          </section>

          <section className={PANEL} aria-labelledby="why-title">
            <p className={EYEBROW}>POLYMARKET ODDS</p>
            <h2 id="why-title" className="mt-1 text-xl font-semibold">
              Why these weights
            </h2>
            <div className="mt-4 grid gap-6">
              {tilted ? (
                <PolymarketSection weights={tilted} start={result.start} />
              ) : (
                <Pending part={result.weights} loading="Reading this week's odds moves…" />
              )}
              <div className="grid gap-3">
                <h3 className="text-base font-semibold">If the event happens, or does not</h3>
                {result.risk.state === "ready" ? (
                  <RiskSection risk={result.risk.data} />
                ) : (
                  <Pending part={result.risk} loading="Working out the event scenarios…" />
                )}
              </div>
            </div>
          </section>

          <section className={PANEL} aria-labelledby="panel-title">
            <p className={EYEBROW}>AI PANEL</p>
            <h2 id="panel-title" className="mt-1 text-xl font-semibold">
              What five AI agents think
            </h2>
            <div className="mt-4">
              {result.votes.state === "ready" ? (
                <PanelSection votes={result.votes.data} />
              ) : (
                <Pending part={result.votes} loading="Five agents are voting…" />
              )}
            </div>
          </section>

          <section className={PANEL} aria-labelledby="next-title">
            <p className={EYEBROW}>NEXT</p>
            <h2 id="next-title" className="mt-1 text-xl font-semibold">
              What would you like to do with it?
            </h2>
            <div className="mt-4 flex flex-wrap items-start gap-3">
              <a
                href={labBasketUrl(
                  result.stocks.stocks.map((stock) => stock.symbol),
                  result.idea,
                )}
                className="rounded-full bg-blue px-4 py-2 text-sm font-semibold text-surface hover:opacity-90"
              >
                Paper-trade this basket →
              </a>
              <button
                type="button"
                onClick={reset}
                className="rounded-full border border-line px-4 py-2 text-sm font-semibold hover:border-blue hover:text-blue"
              >
                Try another idea
              </button>
              {/* Saving waits for the weights, so the saved basket is the one shown. */}
              {result.weights.state === "loading" ? (
                <p className="py-2 text-sm text-muted">Save &amp; share is ready in a moment…</p>
              ) : (
                <SaveShare
                  key={result.idea}
                  idea={result.idea}
                  stocks={result.stocks}
                  weights={tilted}
                />
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}
