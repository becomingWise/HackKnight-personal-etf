"use client";

// Backend test console: idea → POST /api/stocks (the Gemini stock agent) → POST /api/weights
// → POST /api/risk.
// Not the product UI (that is the frontend teammate's); it only shows what the API returns.
import { useState, type ReactNode } from "react";

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
type Risk = {
  markets: {
    title: string;
    url: string;
    probability: number;
    ifYesPct: number;
    ifNoPct: number;
  }[];
  uncovered: string[];
  basis: string;
  note: string;
};
type Step<T> =
  | { state: "idle" | "running" | "skipped" }
  | { state: "done"; data: T; ms: number }
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

async function call<T>(path: string, body: unknown): Promise<{ data: T; ms: number }> {
  const started = performance.now();
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": sessionId() },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(data?.error?.message ?? `${path} answered ${response.status}.`);
  return { data: data as T, ms: Math.round(performance.now() - started) };
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
const move = (pct: number) => `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`;
const moveColor = (pct: number) =>
  pct > 0.004 ? "text-up" : pct < -0.004 ? "text-down" : "text-muted";
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

export function Console({ demoIdeas }: { demoIdeas: readonly string[] }) {
  const [idea, setIdea] = useState<string>(demoIdeas[0] ?? "");
  const [busy, setBusy] = useState(false);
  const [stocks, setStocks] = useState<Step<Stocks>>(IDLE);
  const [weights, setWeights] = useState<Step<Weights>>(IDLE);
  const [risk, setRisk] = useState<Step<Risk>>(IDLE);
  const [start, setStart] = useState<{ symbol: string; weightPct: number }[]>([]);

  async function run(text: string) {
    const wanted = text.trim();
    if (!wanted || busy) return;
    setBusy(true);
    setStocks(RUNNING);
    setWeights(IDLE);
    setRisk(IDLE);
    setStart([]);
    try {
      let picked: { data: Stocks; ms: number };
      try {
        picked = await call<Stocks>("/api/stocks", { idea: wanted });
        setStocks({ state: "done", ...picked });
      } catch (err) {
        setStocks(failure(err));
        setWeights(SKIPPED);
        setRisk(SKIPPED);
        return;
      }
      const holdings = startingWeights(picked.data.stocks.map((s) => s.symbol));
      setStart(holdings);
      setWeights(RUNNING);
      // Event risk is measured on the tilted basket, or the starting one if tilting failed.
      let basket = holdings;
      try {
        const tilted = await call<Weights>("/api/weights", { idea: wanted, holdings });
        setWeights({ state: "done", ...tilted });
        basket = tilted.data.holdings;
      } catch (err) {
        setWeights(failure(err));
      }
      setRisk(RUNNING);
      try {
        setRisk({ state: "done", ...(await call<Risk>("/api/risk", { holdings: basket })) });
      } catch (err) {
        setRisk(failure(err));
      }
    } finally {
      setBusy(false);
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
          A new idea uses Gemini quota (2 calls normally, 4 at most, free tier). Repeating an idea
          in this tab within 15 minutes is free. This tab is one session: preferences you state (for
          example &quot;no oil companies&quot;) are remembered for it.
        </p>
      </section>

      <Card
        n="1 · STOCKS"
        title="Gemini picks three stocks"
        time={stocks.state === "done" ? seconds(stocks.ms) : undefined}
        badge={stocks.state === "done" && <Pill kind="plain">POST /api/stocks</Pill>}
      >
        {stocks.state !== "done" ? (
          <Waiting
            step={stocks}
            idle="Run an idea: one Gemini agent with retrieval, tools and memory answers."
          />
        ) : (
          <div className="grid gap-3">
            <p className="text-base font-medium">{stocks.data.summary}</p>
            <ul className="grid gap-2 sm:grid-cols-3">
              {stocks.data.stocks.map((stock) => (
                <li key={stock.symbol} className="rounded-xl border border-line p-3 text-sm">
                  <strong className="font-mono text-base">{stock.symbol}</strong>
                  <p className="text-muted">{stock.name}</p>
                </li>
              ))}
            </ul>
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
      <Card
        n="3 · EVENT RISK"
        title="What's at stake if each event happens"
        time={risk.state === "done" ? seconds(risk.ms) : undefined}
        badge={risk.state === "done" && <Pill kind="plain">POST /api/risk</Pill>}
      >
        {risk.state !== "done" ? (
          <Waiting
            step={risk}
            idle="The basket's move if each linked Polymarket event happens, or doesn't."
          />
        ) : (
          <div className="grid gap-3 text-sm">
            {risk.data.markets.length > 0 ? (
              <table className="w-full text-left">
                <thead className="text-xs tracking-wide text-muted">
                  <tr>
                    <th className="py-1 font-medium">MARKET</th>
                    <th className="py-1 text-right font-medium">ODDS</th>
                    <th className="py-1 text-right font-medium">IF YES</th>
                    <th className="py-1 text-right font-medium">IF NO</th>
                  </tr>
                </thead>
                <tbody>
                  {risk.data.markets.map((market) => (
                    <tr key={market.url + market.title} className="border-t border-line">
                      <td className="py-1 pr-3">
                        <a
                          className="text-blue hover:underline"
                          href={market.url}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {market.title}
                        </a>
                      </td>
                      <td className="py-1 text-right font-mono">{percent(market.probability)}</td>
                      <td className={`py-1 text-right font-mono ${moveColor(market.ifYesPct)}`}>
                        {move(market.ifYesPct)}
                      </td>
                      <td className={`py-1 text-right font-mono ${moveColor(market.ifNoPct)}`}>
                        {move(market.ifNoPct)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="text-muted">No live Polymarket market is linked to these stocks.</p>
            )}
            {risk.data.uncovered.length > 0 && (
              <p className="text-muted">
                No measurable event exposure: {risk.data.uncovered.join(", ")}
              </p>
            )}
            <p className="text-xs text-muted">
              {risk.data.note} {risk.data.basis}
            </p>
          </div>
        )}
      </Card>
    </div>
  );
}
