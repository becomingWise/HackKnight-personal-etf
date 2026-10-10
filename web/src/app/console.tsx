"use client";

// Backend test console: idea → POST /api/stocks (the Gemini stock agent) → POST /api/votes (five
// AI voters on that basket) and POST /api/weights.
// Not the product UI (that is the frontend teammate's); it only shows what the API returns.
import { useEffect, useState, type ReactNode } from "react";

type Stocks = { summary: string; stocks: { symbol: string; name: string }[] };
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
};
type Vote = { agent: string; vote: "yes" | "no" | "none"; reason: string };
type Votes = {
  summary: string;
  stocks: { symbol: string; name: string; yes: number; no: number; votes: Vote[] }[];
};
type Savings = {
  day: string;
  answers: number;
  newAnswers: number;
  reused: number;
  reusedPct: number;
  geminiCalls: number;
};
/** X-Cache and X-Odds-Moved of an answer: was it reused, and how far have its odds moved? */
type Reuse = { cache: string | null; moved: string | null };
type Step<T> =
  | { state: "idle" | "running" | "skipped" }
  | { state: "done"; data: T; ms: number; reuse: Reuse }
  | { state: "error"; message: string };
const IDLE = { state: "idle" } as const;
const RUNNING = { state: "running" } as const;
const SKIPPED = { state: "skipped" } as const;

/** One id per browser tab: the agent keeps preferences and earlier baskets per session. */
function sessionId(): string {
  try {
    const stored = sessionStorage.getItem("myetf.sessionId");
    if (stored) return stored;
    const created = crypto.randomUUID();
    sessionStorage.setItem("myetf.sessionId", created);
    return created;
  } catch {
    return "console";
  }
}

async function call<T>(
  path: string,
  body: unknown,
): Promise<{ data: T; ms: number; reuse: Reuse }> {
  const started = performance.now();
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId() },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `${path} answered ${response.status}.`);
  return {
    data: data as T,
    ms: Math.round(performance.now() - started),
    reuse: { cache: response.headers.get("X-Cache"), moved: response.headers.get("X-Odds-Moved") },
  };
}

/** Today's counters; null when they cannot be read (the console works without them). */
async function fetchSavings(): Promise<Savings | null> {
  try {
    const response = await fetch("/api/savings", { cache: "no-store" });
    return response.ok ? ((await response.json()) as Savings) : null;
  } catch {
    return null;
  }
}

const failure = (err: unknown) => ({
  state: "error" as const,
  message: err instanceof Error ? err.message : "The request failed.",
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

function Pill({ kind, children }: { kind: "ok" | "plain"; children: ReactNode }) {
  const style = kind === "ok" ? "bg-up-soft text-up" : "bg-blue-soft text-blue";
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-xs font-medium ${style}`}>{children}</span>
  );
}

function Waiting({ step, idle }: { step: { state: string; message?: string }; idle: string }) {
  if (step.state === "running") return <p className="text-sm text-muted">Running…</p>;
  if (step.state === "skipped")
    return <p className="text-sm text-muted">Skipped: the stock step did not return a basket.</p>;
  if (step.state === "error") return <p className="text-sm text-down">{step.message}</p>;
  return <p className="text-sm text-muted">{idle}</p>;
}

/** One stock's panel result: the count, a yes/no bar and each agent's one-line reason. */
function StockVotes({ stock }: { stock: Votes["stocks"][number] }) {
  const total = stock.votes.length;
  const silent = total - stock.yes - stock.no;
  return (
    <div className="mt-3 grid gap-2 border-t border-line pt-3">
      <p className="font-medium">
        {stock.yes} of {total} agents say yes
      </p>
      <div
        className="flex h-2 overflow-hidden rounded-full bg-line"
        role="img"
        aria-label={`${stock.yes} yes, ${stock.no} no${silent ? `, ${silent} no answer` : ""}`}
      >
        <div className="bg-up" style={{ width: `${(stock.yes / total) * 100}%` }} />
        <div className="bg-down" style={{ width: `${(stock.no / total) * 100}%` }} />
      </div>
      <ul className="grid gap-1.5 text-xs">
        {stock.votes.map((vote) => (
          <li key={vote.agent}>
            <span
              className={`font-semibold ${vote.vote === "yes" ? "text-up" : vote.vote === "no" ? "text-down" : "text-muted"}`}
            >
              {vote.vote === "none" ? "NO ANSWER" : vote.vote.toUpperCase()}
            </span>{" "}
            <span className="font-medium">{vote.agent}</span>
            {vote.vote !== "none" && <span className="text-muted">: {vote.reason}</span>}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Reused or new, and how far the odds behind the answer have moved since it was made. */
function ReusePill({ reuse }: { reuse: Reuse }) {
  if (!reuse.cache) return null;
  const moved = reuse.moved === null ? "" : ` · odds moved ${reuse.moved} pts`;
  return reuse.cache === "HIT" ? (
    <Pill kind="ok">reused, no Gemini call{moved}</Pill>
  ) : (
    <Pill kind="plain">new answer{moved}</Pill>
  );
}

export function Console({ demoIdeas }: { demoIdeas: readonly string[] }) {
  const [idea, setIdea] = useState<string>(demoIdeas[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [stocks, setStocks] = useState<Step<Stocks>>(IDLE);
  const [votes, setVotes] = useState<Step<Votes>>(IDLE);
  const [weights, setWeights] = useState<Step<Weights>>(IDLE);
  const [start, setStart] = useState<{ symbol: string; weightPct: number }[]>([]);
  const [savings, setSavings] = useState<Savings | null>(null);

  useEffect(() => {
    let shown = true;
    void fetchSavings().then((loaded) => {
      if (shown && loaded) setSavings(loaded);
    });
    return () => {
      shown = false;
    };
  }, []);

  async function run(text: string) {
    const wanted = text.trim();
    if (!wanted || busy) return;
    setBusy(true);
    setStocks(RUNNING);
    setVotes(IDLE);
    setWeights(IDLE);
    setStart([]);
    try {
      let picked: { data: Stocks; ms: number; reuse: Reuse };
      try {
        picked = await call<Stocks>("/api/stocks", { idea: wanted });
        setStocks({ state: "done", ...picked });
      } catch (err) {
        setStocks(failure(err));
        setVotes(SKIPPED);
        setWeights(SKIPPED);
        return;
      }
      const holdings = startingWeights(picked.data.stocks.map((s) => s.symbol));
      setStart(holdings);
      setVotes(RUNNING);
      setWeights(RUNNING);
      // The panel and the weights do not depend on each other.
      await Promise.all([
        call<Votes>("/api/votes", { idea: wanted, stocks: picked.data.stocks }).then(
          (voted) => setVotes({ state: "done", ...voted }),
          (err) => setVotes(failure(err)),
        ),
        call<Weights>("/api/weights", { idea: wanted, holdings }).then(
          (weighted) => setWeights({ state: "done", ...weighted }),
          (err) => setWeights(failure(err)),
        ),
      ]);
    } finally {
      setBusy(false);
      void fetchSavings().then((loaded) => loaded && setSavings(loaded));
    }
  }

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
          <span className="text-xs text-muted">Try:</span>
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
          A new idea uses Gemini quota (free tier): 2 calls normally, 4 at most, for the stocks,
          plus 5 Flash-Lite calls for the voting panel. An answer that rests on Polymarket markets
          is reused, for everyone, until one of them moves 3 points (24 hours at most); other
          answers for 15 minutes (votes: 30). This tab is one session: preferences you state (for
          example &quot;no oil companies&quot;) are remembered for it.
        </p>
      </section>

      <section className="rounded-panel border border-line bg-surface px-5 py-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <p className="text-xs font-semibold tracking-[0.18em] text-blue">SAVED TODAY</p>
          <p className="text-sm text-muted">
            Gemini thinks again only when the Polymarket odds behind an answer move 3 points.
          </p>
          <Pill kind="plain">GET /api/savings</Pill>
        </div>
        {savings ? (
          <dl className="mt-3 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-xs text-muted">Answers served</dt>
              <dd className="font-mono text-lg font-semibold">{savings.answers}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Reused, no Gemini call</dt>
              <dd className="font-mono text-lg font-semibold text-up">
                {savings.reused} ({savings.reusedPct}%)
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Needed new Gemini calls</dt>
              <dd className="font-mono text-lg font-semibold">{savings.newAnswers}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Gemini calls today</dt>
              <dd className="font-mono text-lg font-semibold">{savings.geminiCalls}</dd>
            </div>
          </dl>
        ) : (
          <p className="mt-2 text-sm text-muted">Loading the counters…</p>
        )}
        {savings && (
          <p className="mt-2 text-xs text-muted">
            Stocks and votes answers since midnight Pacific time ({savings.day}).
          </p>
        )}
      </section>

      <Card
        n="1 · STOCKS"
        title="Gemini picks three stocks"
        time={stocks.state === "done" ? seconds(stocks.ms) : undefined}
        badge={
          stocks.state === "done" && (
            <>
              <Pill kind="plain">POST /api/stocks</Pill>
              <ReusePill reuse={stocks.reuse} />
            </>
          )
        }
      >
        {stocks.state !== "done" ? (
          <Waiting
            step={stocks}
            idle="Run an idea: one Gemini agent with retrieval, tools and memory answers."
          />
        ) : (
          <div className="grid gap-3">
            <p className="text-base font-medium">{stocks.data.summary}</p>
            <ul className="grid items-start gap-2 sm:grid-cols-3">
              {stocks.data.stocks.map((stock) => {
                const voted =
                  votes.state === "done" &&
                  votes.data.stocks.find((s) => s.symbol === stock.symbol);
                return (
                  <li key={stock.symbol} className="rounded-xl border border-line p-3 text-sm">
                    <strong className="font-mono text-base">{stock.symbol}</strong>
                    <p className="text-muted">{stock.name}</p>
                    {voted && <StockVotes stock={voted} />}
                  </li>
                );
              })}
            </ul>
            <div className="grid gap-1 text-sm">
              <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="text-xs font-semibold tracking-[0.18em] text-blue">AI VOTES</span>
                {votes.state === "done" && (
                  <>
                    <span className="font-medium">{votes.data.summary}</span>
                    <Pill kind="plain">POST /api/votes</Pill>
                    <ReusePill reuse={votes.reuse} />
                    <span className="ml-auto font-mono text-xs text-muted">
                      {seconds(votes.ms)}
                    </span>
                  </>
                )}
                {votes.state === "running" && (
                  <span className="text-muted">Five AI agents are voting…</span>
                )}
                {votes.state === "error" && <span className="text-down">{votes.message}</span>}
              </p>
              <p className="text-xs text-muted">AI opinions, not financial advice.</p>
            </div>
          </div>
        )}
      </Card>

      <Card
        n="2 · WEIGHTS"
        title="Tilted by how Polymarket odds moved"
        time={weights.state === "done" ? seconds(weights.ms) : undefined}
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
            {weights.data.evidence.length > 0 ? (
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
            ) : (
              <p className="text-muted">No live Polymarket market is linked to these stocks.</p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
