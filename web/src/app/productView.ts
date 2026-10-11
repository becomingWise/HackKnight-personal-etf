// The product pages' wording, shared types and small calculations. Pure functions, so every
// sentence a visitor reads can be tested without rendering a page (productView.spec.ts).
// The track record and Polymarket wording lives in consoleView.ts.
import type { Evidence } from "./consoleView";

export const PITCH = "Turn an idea into a stock basket, backed by live prediction-market odds.";
export const DISCLAIMER =
  "Paper portfolios for research and fun. Not investment advice. Not affiliated with Polymarket or Kalshi.";

/** The shared header. The Lab is a separate static page, so it is opened with a full page load. */
export const NAV = [
  { href: "/", label: "Build", fullLoad: false },
  { href: "/lab", label: "Paper-trade Lab", fullLoad: true },
  { href: "/track-record", label: "Track record", fullLoad: false },
  { href: "/how-it-works", label: "How it works", fullLoad: false },
] as const;

export function isCurrent(href: string, pathname: string): boolean {
  if (href === "/") return pathname === "/" || pathname.startsWith("/b/");
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** Four ideas the 40 tickers cover; each has been checked to give a basket, not a question. */
export const EXAMPLE_IDEAS = [
  "AI chips and Taiwan risk",
  "Oil majors and Strait of Hormuz shipping",
  "Banks if interest rates stay high",
  "Bitcoin reaching $100k",
] as const;

// ---- What the API returns (docs/API.md sections 1, 1d, 2, 2b, 3, 4b, 4c) ----

export type Stocks = { summary: string; stocks: { symbol: string; name: string }[] };
export type Holding = { symbol: string; weightPct: number };
export type Weights = {
  status: string;
  holdings: Holding[];
  explanation: string;
  evidence: Evidence[];
};
export type Vote = { agent: string; vote: "yes" | "no" | "none"; reason: string };
export type AgentRecord = {
  agent: string;
  n: number;
  correct: number;
  pct: number | null;
  shrunkPct?: number;
};
export type BeatsSpy = {
  asOf: string | null;
  yes: number;
  no: number;
  majority: "yes" | "no" | null;
  calls: (Vote & { probability: number | null })[];
};
export type Votes = {
  summary: string;
  stocks: { symbol: string; name: string; yes: number; no: number; votes: Vote[] }[];
  beatsSpy?: BeatsSpy;
  records?: AgentRecord[];
};
export type Risk = {
  markets: {
    title: string;
    url: string;
    probability: number;
    ifYesPct: number;
    ifNoPct: number;
    drivers: { symbol: string }[];
  }[];
  uncovered: string[];
  basis: string;
  note: string;
};
export type SavedBasket = { id: string; url: string };
export type Letter = { letter: string; source: string };
export type Narration = {
  mode: "live" | "mock";
  script: string;
  audioUrl: string | null;
  durationSeconds: number | null;
};

// ---- Progress while an idea is worked on ----

export type Phase = "idle" | "stocks" | "panel" | "done";
export type ProgressStep = { label: string; state: "done" | "active" | "waiting" };
const STEP_LABELS = ["Reading Polymarket odds", "Picking stocks", "5 agents voting"] as const;

/**
 * The three steps shown while an idea runs. The first two happen inside one request (the server
 * reads the odds, then the agent picks), so `oddsRead` says when to move from the first to the
 * second; the third covers the voting panel and the weights.
 */
export function progressSteps(phase: Phase, oddsRead = false): ProgressStep[] {
  const active = phase === "stocks" ? (oddsRead ? 1 : 0) : phase === "panel" ? 2 : -1;
  const allDone = phase === "done";
  return STEP_LABELS.map((label, index) => ({
    label,
    state:
      allDone || (active >= 0 && index < active) ? "done" : index === active ? "active" : "waiting",
  }));
}

// ---- Errors in plain words ----

export type Failure = { status?: number; code?: string; network?: boolean };

/** What to tell a visitor when a request fails. The server's own message is never shown raw. */
export function plainError(failure: Failure, what = "this"): string {
  if (failure.network) return "We could not reach ProphETF. Check your connection and try again.";
  const { status, code } = failure;
  if (status === 429 || code === "rate_limited") {
    return "Too many requests right now. Please wait a minute and try again.";
  }
  if (code === "gemini_unavailable" || code === "ai_budget_used_up" || code === "not_configured") {
    return "The AI has used up its free quota for now. Please try again in a little while.";
  }
  if (code === "invalid_idea" || status === 400 || status === 413) {
    return "Please type an investing idea of up to 500 characters.";
  }
  if (status === 404) return "We could not find that. It may have been removed.";
  if (code === "timeout" || status === 504) {
    return "That took too long. Please try again.";
  }
  return `Something went wrong on our side with ${what}. Please try again.`;
}

// ---- The basket ----

/** Equal starting weights that total exactly 100 (the last one takes the rounding). */
export function equalWeights(symbols: string[]): Holding[] {
  if (!symbols.length) return [];
  const cents = Math.floor(10000 / symbols.length);
  return symbols.map((symbol, i) => ({
    symbol,
    weightPct: (i === symbols.length - 1 ? 10000 - cents * i : cents) / 100,
  }));
}

export type BasketRow = {
  symbol: string;
  name: string;
  weightPct: number;
  startPct: number;
  /** "▲ 3.8 pts", "▼ 1.2 pts" or "no change". */
  change: string;
  direction: "up" | "down" | "flat";
};

/** One row per stock: its weight after the odds tilt, and how far that is from the equal start. */
export function basketRows(
  stocks: Stocks["stocks"],
  start: Holding[],
  tilted: Holding[] | null,
): BasketRow[] {
  return stocks.map((stock) => {
    const startPct = start.find((h) => h.symbol === stock.symbol)?.weightPct ?? 0;
    const weightPct = tilted?.find((h) => h.symbol === stock.symbol)?.weightPct ?? startPct;
    const points = Math.round((weightPct - startPct) * 10) / 10;
    return {
      symbol: stock.symbol,
      name: stock.name,
      weightPct,
      startPct,
      change:
        points === 0 ? "no change" : `${points > 0 ? "▲" : "▼"} ${Math.abs(points).toFixed(1)} pts`,
      direction: points > 0 ? "up" : points < 0 ? "down" : "flat",
    };
  });
}

/** "37.1%" */
export const weightText = (weightPct: number) => `${weightPct.toFixed(1)}%`;

/** One line under the basket saying where the weights come from. */
export function weightsNote(weights: Weights | null, failed: boolean): string {
  if (failed) return "The odds tilt is not available right now, so the weights are equal.";
  if (!weights) return "Equal weights for now; the tilt by Polymarket odds is being worked out.";
  return weights.status === "adjusted"
    ? "Weights start equal and are tilted by how the linked Polymarket odds moved this week."
    : "Equal weights: no linked Polymarket market moved enough this week to tilt them.";
}

// ---- Event risk ----

/** "+1.50%", "−0.10%", "0.00%": a basket move with a real minus sign. */
export function movePct(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded === 0) return "0.00%";
  return `${rounded > 0 ? "+" : "−"}${Math.abs(rounded).toFixed(2)}%`;
}

export const moveTone = (value: number): "up" | "down" | "muted" => {
  const rounded = Math.round(value * 100) / 100;
  return rounded > 0 ? "up" : rounded < 0 ? "down" : "muted";
};

// ---- The AI panel ----

/** "56% right, n=80": a share never appears without the number of calls behind it. */
export function recordText(record: Pick<AgentRecord, "n" | "pct"> | undefined): string {
  if (!record || !record.n || record.pct === null) return "no record yet";
  return `${Math.round(record.pct)}% right, n=${record.n}`;
}

/** The panel's call on the whole basket, as a headline and a short verdict. */
export function spyCallText(call: Pick<BeatsSpy, "yes" | "majority" | "calls">): {
  headline: string;
  verdict: string;
  tone: "up" | "down" | "muted";
} {
  const total = call.calls.length;
  return {
    headline: `${call.yes} of ${total} agents expect it to beat the S&P 500 next week`,
    verdict:
      call.majority === "yes"
        ? "Panel says yes"
        : call.majority === "no"
          ? "Panel says no"
          : "No majority",
    tone: call.majority === "yes" ? "up" : call.majority === "no" ? "down" : "muted",
  };
}

/** "4 of 5 say yes" for one stock; agents that gave no answer are named as such. */
export function stockVoteText(
  stock: Pick<Votes["stocks"][number], "yes" | "no" | "votes">,
): string {
  const total = stock.votes.length;
  const silent = total - stock.yes - stock.no;
  return `${stock.yes} of ${total} say yes` + (silent > 0 ? ` (${silent} gave no answer)` : "");
}

// ---- Save & share ----

/** The body of POST /api/baskets: the two responses as received (weights null when they failed). */
export function saveBody(idea: string, stocks: Stocks, weights: Weights | null) {
  return { idea, stocks, weights };
}

/** Only links to our own share pages are shown: "/b/7fkbjd9w". */
export function sharePath(basket: { id: string }): string | null {
  return /^[a-z0-9]{6,12}$/.test(basket.id) ? `/b/${basket.id}` : null;
}

/** Only http(s) links from the API are rendered as links. */
export function safeLink(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}

// ---- How it works: live numbers ----

/** "27,134" */
export const count = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "—";

/** "just now", "5 minutes ago", "3 hours ago", "2 days ago"; "—" for no or a future time. */
export function ago(iso: string | null | undefined, now: Date = new Date()): string {
  const then = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(then)) return "—";
  const seconds = Math.round((now.getTime() - then) / 1000);
  if (seconds < 0) return "—";
  if (seconds < 90) return "just now";
  const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? "" : "s"} ago`;
  if (seconds < 90 * 60) return plural(Math.round(seconds / 60), "minute");
  if (seconds < 36 * 3600) return plural(Math.round(seconds / 3600), "hour");
  return plural(Math.round(seconds / 86_400), "day");
}

export type BuiltWith = {
  tiger?: {
    rows?: Record<string, number | undefined>;
    /** Polymarket markets cited by saved baskets: the ones the tick job follows. */
    trackedMarkets?: number;
    lastTickAt?: string | null;
    timescaledb?: string | null;
    postgres?: string | null;
  };
  gemini?: { chains?: { decide?: string[]; managersNote?: string[] }; lettersWritten?: number };
  elevenlabs?: { briefings?: number; audioSeconds?: number; model?: string; mode?: string };
};
export type Savings = {
  day: string;
  answers: number;
  newAnswers: number;
  reused: number;
  reusedPct: number;
  geminiCalls: number;
};

export type TechCard = {
  name: string;
  role: string;
  /** Live numbers or plain facts; a card may have none. */
  stats: { label: string; value: string }[];
};
export type TechGroup = { title: string; cards: TechCard[] };

/**
 * The How it works page's cards in two groups: what the product itself runs on, and what we
 * built and run it with. Only tools the repository really uses are listed. Live numbers come from
 * GET /api/built-with and GET /api/savings; one that could not be read is "—", never guessed.
 */
export function techGroups(
  built: BuiltWith | null,
  savings: Savings | null,
  now: Date = new Date(),
): TechGroup[] {
  const rows = built?.tiger?.rows ?? {};
  const models = (built?.gemini?.chains?.decide ?? []).filter((m) => m.includes("flash-lite"));
  const lastTick = ago(built?.tiger?.lastTickAt, now);
  return [
    {
      title: "In the product",
      cards: [
        {
          name: "Google Gemini",
          role: "One agent picks the three stocks, five agents vote on them, and a manager's note is written when a basket is saved. An answer is reused until the odds behind it move 3 points.",
          stats: [
            { label: "Models", value: models.length ? models.slice(0, 2).join(", ") : "—" },
            { label: "Gemini calls today", value: count(savings?.geminiCalls) },
            {
              label: "Answers reused today",
              value: savings
                ? `${savings.reusedPct}% (${savings.reused} of ${savings.answers})`
                : "—",
            },
          ],
        },
        {
          name: "Tiger Data",
          role: "Postgres with TimescaleDB keeps every odds reading, the stock closes and each panel decision, so charts and the track record are plain SQL.",
          stats: [
            { label: "Odds readings (odds_ticks)", value: count(rows.odds_ticks) },
            { label: "Stock closes (stock_closes)", value: count(rows.stock_closes) },
            { label: "Panel decisions", value: count(rows.panel_decisions) },
            { label: "Latest odds reading", value: lastTick },
          ],
        },
        {
          name: "Polymarket and Kalshi data",
          role: "Public prediction-market odds, read-only. No keys, no accounts and no orders: the odds show what is at stake, not which way to bet.",
          stats: [
            { label: "Markets tracked", value: count(built?.tiger?.trackedMarkets) },
            { label: "Access", value: "Read-only, no keys" },
          ],
        },
        {
          name: "Stock prices",
          role: "Daily closing prices from Yahoo Finance, loaded with Hao's Python code. They score every panel decision against the S&P 500.",
          stats: [
            { label: "Source", value: "Yahoo Finance" },
            { label: "Daily closes stored", value: count(rows.stock_closes) },
          ],
        },
      ],
    },
    {
      title: "How we built and run it",
      cards: [
        {
          name: "Claude Code",
          role: "Wrote and tested the backend, the stock agent, the voting panel and this website, working from Lucas's specifications.",
          stats: [],
        },
        {
          name: "Vercel",
          role: "Hosts the website and the API as one Next.js app, deployed from the command line.",
          stats: [],
        },
        {
          name: "cron-job.org",
          role: "Calls our odds job every minute, which stores one reading per tracked market in Tiger Data. The time below is the newest reading it wrote.",
          stats: [
            { label: "Job", value: "/api/jobs/tick, every minute" },
            { label: "Last tick", value: lastTick },
          ],
        },
        {
          name: "GitHub and GitHub Actions",
          role: "The repository, and the tests of every part run on each pull request.",
          stats: [],
        },
        {
          name: "Next.js and TypeScript",
          role: "The website and the API routes. The stock agent itself is plain JavaScript, shared with a local server.",
          stats: [],
        },
        {
          name: "Python",
          role: "Hao's research (the event study and the backtests) and the weighting method. The live weights are a TypeScript port, kept identical by a parity test.",
          stats: [],
        },
      ],
    },
  ];
}

/** The pipeline drawn on the How it works page. */
export const PIPELINE = [
  { title: "Your idea", text: "A sentence, in any language." },
  { title: "Gemini agent", text: "Picks 3 stocks from 40, or asks you to clarify." },
  { title: "Polymarket odds", text: "Live odds of the events those stocks depend on." },
  { title: "Weights", text: "Equal weights, tilted by this week's odds moves." },
  { title: "5 AI votes", text: "Five agents vote on each stock and on the basket." },
  { title: "Track record", text: "Every call is scored against the S&P 500 a week later." },
  { title: "Lab", text: "Paper-trade the basket and test event scenarios." },
] as const;
