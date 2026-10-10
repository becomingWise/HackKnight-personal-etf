"use client";

// Backend test console: runs the real endpoints in order and shows one card per stage.
// Not the product UI (that is the frontend teammate's); it only renders what the API returns.
import { useState, type ReactNode } from "react";

type Trace = { step: string; status: string; ms: number; summary: string };
type Analysis = {
  packet: {
    markets: {
      id: string;
      question: string;
      url: string;
      probability: number;
      change7d: number | null;
      relevance: number;
      signal: string;
    }[];
    themes: { name: string; direction: string; confidence: number; marketIds: string[] }[];
    warnings: string[];
  };
  gate: { passed: boolean; summary: string; reason?: string };
  trace: Trace[];
};
type Stocks = {
  summary: string;
  stocks: { symbol: string; name: string; reason: string; marketId: string | null }[];
  source: "gemini" | "fallback";
  cached?: boolean;
  trace?: Trace[];
};
type Evidence = {
  title: string;
  url: string;
  probability: number;
  change7d?: number | null;
  symbols?: string[];
};
type Weights = {
  status: string;
  holdings: { symbol: string; weightPct: number }[];
  explanation: string;
  evidence: Evidence[];
  cached?: boolean;
};
type Saved = { id: string; url: string };
type Letter = { letter: string; source: string; words?: number; cached?: boolean };
type Briefing = {
  script: string;
  mode: string;
  audioUrl: string | null;
  durationSeconds: number | null;
  note?: string;
};

type Step<T> =
  | { state: "idle" | "running" | "skipped" }
  | { state: "done"; data: T; ms: number }
  | { state: "error"; message: string; examples?: string[] };
const IDLE = { state: "idle" } as const;
const RUNNING = { state: "running" } as const;
const SKIPPED = { state: "skipped" } as const;

class ApiError extends Error {
  constructor(
    message: string,
    readonly examples?: string[],
  ) {
    super(message);
  }
}

async function call<T>(path: string, body?: unknown): Promise<{ data: T; ms: number }> {
  const started = performance.now();
  const response = await fetch(path, {
    method: "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(
      data?.error?.message ?? `${path} answered ${response.status}.`,
      data?.error?.examples,
    );
  }
  return { data: data as T, ms: Math.round(performance.now() - started) };
}

const failure = (err: unknown) => ({
  state: "error" as const,
  message: err instanceof Error ? err.message : "The request failed.",
  examples: err instanceof ApiError ? err.examples : undefined,
});

/** Equal starting weights that total exactly 100, the same way the team's controller does it. */
function startingWeights(symbols: string[]) {
  const cents = Math.floor(10000 / symbols.length);
  return symbols.map((symbol, i) => ({
    symbol,
    weightPct: (i === symbols.length - 1 ? 10000 - cents * i : cents) / 100,
  }));
}

const percent = (p: number) => `${(p * 100).toFixed(p < 0.1 || p > 0.9 ? 1 : 0)}%`;
const points = (change: number | null | undefined) => {
  if (change === null || change === undefined) return "–";
  const pts = change * 100;
  return `${pts > 0 ? "+" : ""}${pts.toFixed(1)} pts`;
};
const seconds = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
const tone = (word: string) =>
  word === "bullish" ? "text-up" : word === "bearish" ? "text-down" : "text-muted";

function Card(props: {
  n: string;
  title: string;
  time?: string;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="rounded-panel border border-line bg-surface p-5">
      <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <p className="text-xs font-semibold tracking-[0.18em] text-blue">{props.n}</p>
        <h2 className="text-lg font-semibold">{props.title}</h2>
        {props.badge}
        {props.time && <span className="ml-auto font-mono text-xs text-muted">{props.time}</span>}
      </div>
      {props.children}
    </section>
  );
}

function Pill({ kind, children }: { kind: "ok" | "bad" | "warn" | "plain"; children: ReactNode }) {
  const style = {
    ok: "bg-up-soft text-up",
    bad: "bg-down-soft text-down",
    warn: "bg-warn-soft text-warn",
    plain: "bg-blue-soft text-blue",
  }[kind];
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>{children}</span>
  );
}

function Waiting({
  step,
  idle,
}: {
  step: { state: string; message?: string; examples?: string[] };
  idle: string;
}) {
  if (step.state === "running") return <p className="text-sm text-muted">Running…</p>;
  if (step.state === "skipped")
    return <p className="text-sm text-muted">Skipped: an earlier stage stopped the run.</p>;
  if (step.state === "error")
    return (
      <div className="text-sm text-down">
        <p>{step.message}</p>
      </div>
    );
  return <p className="text-sm text-muted">{idle}</p>;
}

export function Console({ demoIdeas }: { demoIdeas: readonly string[] }) {
  const [idea, setIdea] = useState<string>(demoIdeas[0] ?? "");
  const [ranIdea, setRanIdea] = useState("");
  const [busy, setBusy] = useState(false);
  const [analysis, setAnalysis] = useState<Step<Analysis>>(IDLE);
  const [stocks, setStocks] = useState<Step<Stocks>>(IDLE);
  const [weights, setWeights] = useState<Step<Weights>>(IDLE);
  const [start, setStart] = useState<{ symbol: string; weightPct: number }[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Step<Saved>>(IDLE);
  const [letter, setLetter] = useState<Step<Letter>>(IDLE);
  const [briefing, setBriefing] = useState<Step<Briefing>>(IDLE);

  async function run(text: string) {
    const wanted = text.trim();
    if (!wanted || busy) return;
    setBusy(true);
    setRanIdea(wanted);
    setAnalysis(RUNNING);
    setStocks(IDLE);
    setWeights(IDLE);
    setStart([]);
    setSaved(IDLE);
    setLetter(IDLE);
    setBriefing(IDLE);
    try {
      let analyzed: { data: Analysis; ms: number };
      try {
        analyzed = await call<Analysis>("/api/analyze", { idea: wanted });
        setAnalysis({ state: "done", ...analyzed });
      } catch (err) {
        setAnalysis(failure(err));
        setStocks(SKIPPED);
        setWeights(SKIPPED);
        return;
      }
      if (!analyzed.data.gate.passed) {
        setStocks(SKIPPED);
        setWeights(SKIPPED);
        return;
      }

      setStocks(RUNNING);
      let decided: { data: Stocks; ms: number };
      try {
        decided = await call<Stocks>("/api/stocks", { idea: wanted });
        setStocks({ state: "done", ...decided });
      } catch (err) {
        setStocks(failure(err));
        setWeights(SKIPPED);
        return;
      }

      const holdings = startingWeights(decided.data.stocks.map((s) => s.symbol));
      setStart(holdings);
      setWeights(RUNNING);
      try {
        setWeights({
          state: "done",
          ...(await call<Weights>("/api/weights", { idea: wanted, holdings })),
        });
      } catch (err) {
        setWeights(failure(err));
      }
    } finally {
      setBusy(false);
    }
  }

  async function save() {
    if (stocks.state !== "done" || saving) return;
    setSaving(true);
    setSaved(RUNNING);
    setLetter(IDLE);
    setBriefing(IDLE);
    try {
      let basket: { data: Saved; ms: number };
      try {
        basket = await call<Saved>("/api/baskets", {
          idea: ranIdea,
          stocks: stocks.data,
          weights: weights.state === "done" ? weights.data : null,
        });
        setSaved({ state: "done", ...basket });
      } catch (err) {
        setSaved(failure(err));
        return;
      }
      const base = `/api/baskets/${encodeURIComponent(basket.data.id)}`;
      setLetter(RUNNING);
      try {
        setLetter({ state: "done", ...(await call<Letter>(`${base}/letter`)) });
      } catch (err) {
        setLetter(failure(err));
      }
      setBriefing(RUNNING);
      try {
        setBriefing({ state: "done", ...(await call<Briefing>(`${base}/narrate`)) });
      } catch (err) {
        setBriefing(failure(err));
      }
    } finally {
      setSaving(false);
    }
  }

  const packet = analysis.state === "done" ? analysis.data.packet : null;
  const gate = analysis.state === "done" ? analysis.data.gate : null;
  const traceOf = (trace: Trace[] | undefined, step: string) => trace?.find((t) => t.step === step);
  const analystStep =
    analysis.state === "done" ? traceOf(analysis.data.trace, "analyst") : undefined;
  const gateStep = analysis.state === "done" ? traceOf(analysis.data.trace, "gate") : undefined;
  const deciderStep = stocks.state === "done" ? traceOf(stocks.data.trace, "decider") : undefined;
  const checkerStep = stocks.state === "done" ? traceOf(stocks.data.trace, "checker") : undefined;
  const model = deciderStep?.summary.match(/Gemini calls?, ([^)]+)\)/)?.[1];
  const revisions = Number(checkerStep?.summary.match(/(\d+) revision/)?.[1] ?? 0);
  const fromCache = stocks.state === "done" && stocks.data.cached === true;
  const stageTime = (step: Trace | undefined) =>
    step
      ? `${seconds(step.ms)}${fromCache && step.step !== "analyst" && step.step !== "gate" ? " when decided" : ""}`
      : undefined;

  return (
    <div className="grid gap-5">
      <section className="rounded-panel border border-line bg-surface p-5">
        <form
          className="flex flex-wrap gap-3"
          onSubmit={(event) => {
            event.preventDefault();
            void run(idea);
          }}
        >
          <label className="sr-only" htmlFor="idea">
            Investing idea
          </label>
          <input
            id="idea"
            value={idea}
            onChange={(event) => setIdea(event.target.value)}
            maxLength={500}
            placeholder="An investing idea, for example: AI chips and Taiwan risk"
            className="min-w-0 flex-1 basis-72 rounded-xl border border-line bg-bg px-4 py-2.5 text-base outline-none focus:border-blue"
          />
          <button
            type="submit"
            disabled={busy || !idea.trim()}
            className="rounded-xl bg-blue px-6 py-2.5 font-semibold text-white disabled:opacity-50"
          >
            {busy ? "Running…" : "Run"}
          </button>
        </form>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted">Demo ideas (kept cached, no quota):</span>
          {demoIdeas.map((demo) => (
            <button
              key={demo}
              type="button"
              disabled={busy}
              onClick={() => {
                setIdea(demo);
                void run(demo);
              }}
              className="rounded-full border border-line px-3 py-1 text-sm hover:border-blue hover:text-blue disabled:opacity-50"
            >
              {demo}
            </button>
          ))}
        </div>
        <p className="mt-3 rounded-xl bg-warn-soft px-3 py-2 text-sm text-warn">
          A new idea uses Gemini quota (up to 3 calls on the free tier). Prefer the demo ideas;
          repeating an idea within 15 minutes is free.
        </p>
      </section>

      <Card
        n="1 · ANALYST"
        title="Evidence from Polymarket"
        time={analystStep && seconds(analystStep.ms)}
        badge={analystStep && <Pill kind="plain">{analystStep.summary}</Pill>}
      >
        {!packet ? (
          <Waiting step={analysis} idle="Run an idea to see the markets the analyst finds." />
        ) : (
          <div className="grid gap-4">
            {packet.themes.length > 0 && (
              <ul className="flex flex-wrap gap-2 text-sm">
                {packet.themes.map((theme) => (
                  <li key={theme.name} className="rounded-full border border-line px-3 py-1">
                    {theme.name} · <span className={tone(theme.direction)}>{theme.direction}</span>{" "}
                    · confidence {theme.confidence.toFixed(2)} · {theme.marketIds.length} markets
                  </li>
                ))}
              </ul>
            )}
            {packet.themes.length === 0 && <p className="text-sm text-muted">No themes.</p>}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead className="text-xs tracking-wide text-muted">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">MARKET</th>
                    <th className="py-1.5 pr-3 text-right font-medium">ODDS (YES)</th>
                    <th className="py-1.5 pr-3 text-right font-medium">7 DAYS</th>
                    <th className="py-1.5 pr-3 font-medium">SIGNAL</th>
                    <th className="py-1.5 text-right font-medium">RELEVANCE</th>
                  </tr>
                </thead>
                <tbody>
                  {packet.markets.map((market) => (
                    <tr key={market.id} className="border-t border-line">
                      <td className="py-1.5 pr-3">
                        <a
                          className="text-blue hover:underline"
                          href={market.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {market.question}
                        </a>
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono">
                        {percent(market.probability)}
                      </td>
                      <td className="py-1.5 pr-3 text-right font-mono">
                        {points(market.change7d)}
                      </td>
                      <td className={`py-1.5 pr-3 ${tone(market.signal)}`}>{market.signal}</td>
                      <td className="py-1.5 text-right font-mono">{market.relevance.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {packet.warnings.map((warning) => (
              <p key={warning} className="text-xs text-muted">
                {warning}
              </p>
            ))}
          </div>
        )}
      </Card>

      <Card
        n="2 · GATE"
        title="Is there enough evidence?"
        time={gateStep && seconds(gateStep.ms)}
        badge={
          gate && <Pill kind={gate.passed ? "ok" : "bad"}>{gate.passed ? "passed" : "failed"}</Pill>
        }
      >
        {!gate ? (
          <Waiting step={analysis} idle="Plain code: at least 2 relevant, liquid, open markets." />
        ) : (
          <div className="grid gap-1 text-sm">
            {gate.reason && <p className="font-medium">{gate.reason}</p>}
            <p className="text-muted">{gate.summary}</p>
            {!gate.passed && (
              <p className="text-muted">Gemini was not called. Try one of the demo ideas above.</p>
            )}
          </div>
        )}
      </Card>

      <Card
        n="3 · DECIDER"
        title="Gemini picks the stocks"
        time={stageTime(deciderStep)}
        badge={
          stocks.state === "done" && (
            <>
              <Pill kind={stocks.data.source === "gemini" ? "ok" : "warn"}>
                {stocks.data.source === "gemini"
                  ? (model ?? "Gemini")
                  : "answered without Gemini (evidence only)"}
              </Pill>
              {fromCache && <Pill kind="plain">from the 15-minute cache</Pill>}
            </>
          )
        }
      >
        {stocks.state !== "done" ? (
          <Waiting step={stocks} idle="One Gemini call; its only facts are the analyst's packet." />
        ) : (
          <div className="grid gap-3">
            <p className="text-sm text-muted">{stocks.data.summary}</p>
            <ul className="grid gap-2">
              {stocks.data.stocks.map((stock) => (
                <li key={stock.symbol} className="rounded-xl border border-line p-3 text-sm">
                  <p>
                    <strong className="font-mono">{stock.symbol}</strong>{" "}
                    <span className="text-muted">{stock.name}</span>
                  </p>
                  <p className="mt-1">{stock.reason}</p>
                </li>
              ))}
            </ul>
            {deciderStep && <p className="text-xs text-muted">{deciderStep.summary}</p>}
          </div>
        )}
        {stocks.state === "error" && stocks.examples && (
          <p className="mt-2 text-sm text-muted">Ideas that work: {stocks.examples.join(" · ")}</p>
        )}
      </Card>

      <Card
        n="4 · CHECKER"
        title="Code checks every ticker, market and number"
        time={stageTime(checkerStep)}
        badge={
          checkerStep && (
            <Pill kind={checkerStep.status === "ok" ? "ok" : "warn"}>
              {checkerStep.status === "ok" ? "passed" : checkerStep.status}
            </Pill>
          )
        }
      >
        {!checkerStep ? (
          <Waiting
            step={stocks.state === "done" ? IDLE : stocks}
            idle="Allowed tickers, 3 to 5 stocks, cited markets exist, every percentage matches."
          />
        ) : (
          <p className="text-sm">
            {revisions === 0
              ? "No revision needed."
              : `${revisions} revision${revisions > 1 ? "s" : ""}.`}{" "}
            <span className="text-muted">{checkerStep.summary}</span>
          </p>
        )}
      </Card>

      <Card
        n="5 · WEIGHTS"
        title="Tilted by how the odds moved"
        time={
          weights.state === "done" ? `${seconds(weights.ms)} (measured in this browser)` : undefined
        }
        badge={
          weights.state === "done" && (
            <Pill kind={weights.data.status === "adjusted" ? "ok" : "plain"}>
              {weights.data.status}
            </Pill>
          )
        }
      >
        {weights.state !== "done" ? (
          <Waiting
            step={weights}
            idle="Equal weights in, weights tilted by 7-day odds moves out."
          />
        ) : (
          <div className="grid gap-3 text-sm">
            <table className="w-full max-w-md text-left">
              <thead className="text-xs tracking-wide text-muted">
                <tr>
                  <th className="py-1 font-medium">STOCK</th>
                  <th className="py-1 text-right font-medium">BEFORE</th>
                  <th className="py-1 text-right font-medium">AFTER</th>
                  <th className="py-1 text-right font-medium">CHANGE</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {weights.data.holdings.map((holding) => {
                  const before = start.find((s) => s.symbol === holding.symbol)?.weightPct ?? 0;
                  const delta = holding.weightPct - before;
                  return (
                    <tr key={holding.symbol} className="border-t border-line">
                      <td className="py-1 font-semibold">{holding.symbol}</td>
                      <td className="py-1 text-right">{before.toFixed(2)}%</td>
                      <td className="py-1 text-right">{holding.weightPct.toFixed(2)}%</td>
                      <td
                        className={`py-1 text-right ${delta > 0.004 ? "text-up" : delta < -0.004 ? "text-down" : "text-muted"}`}
                      >
                        {delta > 0 ? "+" : ""}
                        {delta.toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <p>{weights.data.explanation}</p>
            {weights.data.evidence.length > 0 && (
              <ul className="grid gap-1">
                {weights.data.evidence.map((item) => (
                  <li key={item.url + item.title} className="text-muted">
                    <a
                      className="text-blue hover:underline"
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {item.title}
                    </a>{" "}
                    <span className="font-mono">
                      {percent(item.probability)} · {points(item.change7d)} over 7 days
                    </span>
                    {item.symbols?.length ? ` · ${item.symbols.join(", ")}` : ""}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </Card>

      <Card
        n="6 · SAVE"
        title="Saved basket, manager's note and audio briefing"
        time={saved.state === "done" ? seconds(saved.ms) : undefined}
      >
        <div className="grid gap-4 text-sm">
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void save()}
              disabled={stocks.state !== "done" || busy || saving || saved.state === "done"}
              className="rounded-xl border border-blue px-5 py-2 font-semibold text-blue disabled:opacity-50"
            >
              {saving ? "Working…" : "Save + letter + audio"}
            </button>
            <span className="max-w-xl text-xs text-warn">
              Each click saves a new basket, writes a new note with the Gemini Flash models (about
              16 a day each) and spends ElevenLabs characters. Use it sparingly.
            </span>
          </div>
          {saved.state === "idle" && stocks.state !== "done" && (
            <p className="text-muted">Run an idea first.</p>
          )}
          {saved.state === "running" && <p className="text-muted">Saving…</p>}
          {saved.state === "error" && <p className="text-down">{saved.message}</p>}
          {saved.state === "done" && (
            <p>
              Share link:{" "}
              <a
                className="text-blue underline"
                href={saved.data.url}
                target="_blank"
                rel="noreferrer"
              >
                {saved.data.url}
              </a>{" "}
              <span className="text-muted">(JSON for now; id {saved.data.id})</span>
            </p>
          )}
          {letter.state === "running" && (
            <p className="text-muted">Writing the manager&apos;s note…</p>
          )}
          {letter.state === "error" && <p className="text-down">{letter.message}</p>}
          {letter.state === "done" && (
            <div>
              <p className="mb-1 text-xs font-semibold tracking-[0.18em] text-muted">
                MANAGER&apos;S NOTE ·{" "}
                {letter.data.source === "gemini"
                  ? "written by Gemini"
                  : "template (Gemini unavailable)"}{" "}
                · {seconds(letter.ms)}
              </p>
              <p className="max-w-3xl">{letter.data.letter}</p>
            </div>
          )}
          {briefing.state === "running" && <p className="text-muted">Recording the briefing…</p>}
          {briefing.state === "error" && <p className="text-down">{briefing.message}</p>}
          {briefing.state === "done" && (
            <div>
              <p className="mb-1 text-xs font-semibold tracking-[0.18em] text-muted">
                AUDIO BRIEFING · {briefing.data.audioUrl ? "ElevenLabs" : "script only"} ·{" "}
                {seconds(briefing.ms)}
              </p>
              {briefing.data.audioUrl ? (
                <audio
                  controls
                  preload="none"
                  src={briefing.data.audioUrl}
                  className="w-full max-w-xl"
                />
              ) : (
                <p className="text-muted">{briefing.data.note ?? "No audio for this basket."}</p>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
