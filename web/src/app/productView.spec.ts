// The product pages' wording and small calculations (productView.ts).
import { describe, expect, it } from "vitest";
import {
  DISCLAIMER,
  EXAMPLE_IDEAS,
  NAV,
  PIPELINE,
  ago,
  basketRows,
  count,
  equalWeights,
  isCurrent,
  movePct,
  moveTone,
  plainError,
  progressSteps,
  recordText,
  safeLink,
  saveBody,
  sharePath,
  spyCallText,
  stockVoteText,
  techGroups,
  weightText,
  weightsNote,
  type Weights,
} from "./productView";

describe("the shared header and footer", () => {
  it("has the four pages in order, and opens the Lab with a full page load", () => {
    expect(NAV.map((item) => [item.label, item.href])).toEqual([
      ["Build", "/"],
      ["Paper-trade Lab", "/lab"],
      ["Track record", "/track-record"],
      ["How it works", "/how-it-works"],
    ]);
    expect(NAV.filter((item) => item.fullLoad).map((item) => item.href)).toEqual(["/lab"]);
  });

  it("marks the current page; a shared basket belongs to Build", () => {
    expect(isCurrent("/", "/")).toBe(true);
    expect(isCurrent("/", "/b/7fkbjd9w")).toBe(true);
    expect(isCurrent("/", "/track-record")).toBe(false);
    expect(isCurrent("/track-record", "/track-record")).toBe(true);
    expect(isCurrent("/how-it-works", "/how-it-works/x")).toBe(true);
    expect(isCurrent("/lab", "/label")).toBe(false);
  });

  it("carries the disclaimer and four example ideas", () => {
    expect(DISCLAIMER).toBe(
      "Paper portfolios for research and fun. Not investment advice. Not affiliated with Polymarket or Kalshi.",
    );
    expect(EXAMPLE_IDEAS).toHaveLength(4);
    expect(new Set(EXAMPLE_IDEAS).size).toBe(4);
  });
});

describe("the progress steps", () => {
  const states = (...args: Parameters<typeof progressSteps>) =>
    progressSteps(...args).map((step) => step.state);

  it("names the three steps", () => {
    expect(progressSteps("idle").map((step) => step.label)).toEqual([
      "Reading Polymarket odds",
      "Picking stocks",
      "5 agents voting",
    ]);
  });

  it("moves from the odds to the pick to the votes", () => {
    expect(states("idle")).toEqual(["waiting", "waiting", "waiting"]);
    expect(states("stocks")).toEqual(["active", "waiting", "waiting"]);
    expect(states("stocks", true)).toEqual(["done", "active", "waiting"]);
    expect(states("panel", true)).toEqual(["done", "done", "active"]);
    expect(states("done", true)).toEqual(["done", "done", "done"]);
  });
});

describe("errors in plain words", () => {
  it("never shows a status code or a server message", () => {
    const failures = [
      { network: true },
      { status: 429, code: "rate_limited" },
      { status: 503, code: "gemini_unavailable" },
      { status: 503, code: "ai_budget_used_up" },
      { status: 400, code: "invalid_idea" },
      { status: 404, code: "not_found" },
      { status: 504, code: "timeout" },
      { status: 502, code: "upstream_error" },
      {},
    ];
    for (const failure of failures) {
      const text = plainError(failure);
      expect(text).not.toMatch(/HTTP|(40\d|42\d|50[234])|error|undefined|null|_/i);
      expect(text.endsWith(".")).toBe(true);
    }
  });

  it("says what to do for the common cases", () => {
    expect(plainError({ network: true })).toMatch(/connection/);
    expect(plainError({ status: 429 })).toMatch(/wait a minute/);
    expect(plainError({ code: "gemini_unavailable" })).toMatch(/free quota/);
    expect(plainError({ status: 400 })).toMatch(/up to 500 characters/);
    expect(plainError({ status: 502 }, "saving the basket")).toBe(
      "Something went wrong on our side with saving the basket. Please try again.",
    );
  });
});

describe("the basket", () => {
  const stocks = [
    { symbol: "NVDA", name: "NVIDIA" },
    { symbol: "TSM", name: "Taiwan Semiconductor" },
    { symbol: "AMD", name: "Advanced Micro Devices" },
  ];

  it("equal weights total exactly 100", () => {
    const start = equalWeights(["A", "B", "C"]);
    expect(start.map((h) => h.weightPct)).toEqual([33.33, 33.33, 33.34]);
    expect(start.reduce((sum, h) => sum + h.weightPct * 100, 0)).toBeCloseTo(10000);
    expect(equalWeights([])).toEqual([]);
    expect(equalWeights(["A"])).toEqual([{ symbol: "A", weightPct: 100 }]);
  });

  it("shows each stock's tilted weight and its move from the equal start", () => {
    const start = equalWeights(stocks.map((s) => s.symbol));
    const rows = basketRows(stocks, start, [
      { symbol: "NVDA", weightPct: 37.12 },
      { symbol: "TSM", weightPct: 29.55 },
      { symbol: "AMD", weightPct: 33.33 },
    ]);
    expect(rows.map((row) => [row.symbol, weightText(row.weightPct), row.change])).toEqual([
      ["NVDA", "37.1%", "▲ 3.8 pts"],
      ["TSM", "29.6%", "▼ 3.8 pts"],
      ["AMD", "33.3%", "no change"],
    ]);
    expect(rows.map((row) => row.direction)).toEqual(["up", "down", "flat"]);
    expect(rows[0].name).toBe("NVIDIA");
  });

  it("falls back to the equal weights while the tilt is missing", () => {
    const start = equalWeights(stocks.map((s) => s.symbol));
    const rows = basketRows(stocks, start, null);
    expect(rows.map((row) => row.weightPct)).toEqual([33.33, 33.33, 33.34]);
    expect(rows.every((row) => row.change === "no change")).toBe(true);
  });

  it("says where the weights come from", () => {
    const weights = (status: string) => ({ status }) as Weights;
    expect(weightsNote(null, false)).toMatch(/being worked out/);
    expect(weightsNote(null, true)).toMatch(/not available right now/);
    expect(weightsNote(weights("adjusted"), false)).toMatch(/tilted by how the linked/);
    expect(weightsNote(weights("unchanged"), false)).toMatch(/^Equal weights/);
  });
});

describe("event risk", () => {
  it("writes moves with a sign and two decimals", () => {
    expect(movePct(1.496)).toBe("+1.50%");
    expect(movePct(-0.104)).toBe("−0.10%");
    expect(movePct(0.004)).toBe("0.00%");
    expect(movePct(-0.004)).toBe("0.00%");
    expect([1.5, -0.1, 0.001].map(moveTone)).toEqual(["up", "down", "muted"]);
  });
});

describe("the AI panel", () => {
  it("an agent's record always carries its n", () => {
    expect(recordText({ n: 80, pct: 56.3 })).toBe("56% right, n=80");
    expect(recordText({ n: 0, pct: null })).toBe("no record yet");
    expect(recordText(undefined)).toBe("no record yet");
  });

  it("states the panel's call on the basket", () => {
    const calls = Array.from({ length: 5 }, (_, i) => ({
      agent: `Agent ${i}`,
      vote: "yes" as const,
      reason: "",
      probability: 0.6,
    }));
    expect(spyCallText({ yes: 4, majority: "yes", calls })).toEqual({
      headline: "4 of 5 agents expect it to beat the S&P 500 next week",
      verdict: "Panel says yes",
      tone: "up",
    });
    expect(spyCallText({ yes: 1, majority: "no", calls }).verdict).toBe("Panel says no");
    expect(spyCallText({ yes: 2, majority: null, calls })).toMatchObject({
      verdict: "No majority",
      tone: "muted",
    });
  });

  it("counts a stock's votes and names missing answers", () => {
    const vote = (v: "yes" | "no" | "none") => ({ agent: "a", vote: v, reason: "" });
    expect(
      stockVoteText({
        yes: 4,
        no: 1,
        votes: ["yes", "yes", "yes", "yes", "no"].map(vote as never),
      }),
    ).toBe("4 of 5 say yes");
    expect(
      stockVoteText({
        yes: 2,
        no: 1,
        votes: ["yes", "yes", "no", "none", "none"].map(vote as never),
      }),
    ).toBe("2 of 5 say yes (2 gave no answer)");
  });
});

describe("save & share", () => {
  it("sends the two responses as received, and null weights when they failed", () => {
    const stocks = { summary: "s", stocks: [{ symbol: "NVDA", name: "NVIDIA" }] };
    expect(saveBody("AI chips", stocks, null)).toEqual({ idea: "AI chips", stocks, weights: null });
  });

  it("only links to a real basket id and to http(s) addresses", () => {
    expect(sharePath({ id: "7fkbjd9w" })).toBe("/b/7fkbjd9w");
    expect(sharePath({ id: "../admin" })).toBeNull();
    expect(sharePath({ id: "" })).toBeNull();
    expect(safeLink("https://polymarket.com/event/x")).toBe("https://polymarket.com/event/x");
    expect(safeLink("javascript:alert(1)")).toBeNull();
    expect(safeLink("not a url")).toBeNull();
    expect(safeLink(null)).toBeNull();
  });
});

describe("how it works", () => {
  const now = new Date("2026-10-10T12:00:00Z");

  it("writes counts and ages for people", () => {
    expect(count(27134)).toBe("27,134");
    expect(count(undefined)).toBe("—");
    expect(ago("2026-10-10T11:59:30Z", now)).toBe("just now");
    expect(ago("2026-10-10T11:55:00Z", now)).toBe("5 minutes ago");
    expect(ago("2026-10-10T09:00:00Z", now)).toBe("3 hours ago");
    expect(ago("2026-10-08T12:00:00Z", now)).toBe("2 days ago");
    expect(ago("2026-10-10T11:59:00Z", now)).toBe("just now");
    expect(ago("2026-10-10T11:58:00Z", now)).toBe("2 minutes ago");
    expect(ago(null, now)).toBe("—");
    expect(ago("2026-10-11T00:00:00Z", now)).toBe("—");
  });

  const built = {
    tiger: {
      rows: { odds_ticks: 27134, stock_closes: 9000, panel_decisions: 90, markets: 211 },
      trackedMarkets: 12,
      lastTickAt: "2026-10-10T11:58:00Z",
    },
    gemini: {
      chains: {
        decide: ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash-lite"],
      },
    },
    elevenlabs: { briefings: 2, audioSeconds: 115 },
  };
  const savings = {
    day: "2026-10-10",
    answers: 42,
    newAnswers: 31,
    reused: 11,
    reusedPct: 26.2,
    geminiCalls: 437,
  };

  it("groups the cards: in the product, and how we built and run it", () => {
    const groups = techGroups(built, savings, now);
    expect(groups.map((group) => [group.title, group.cards.map((card) => card.name)])).toEqual([
      [
        "In the product",
        ["Google Gemini", "Tiger Data", "Polymarket and Kalshi data", "Stock prices"],
      ],
      [
        "How we built and run it",
        [
          "Claude Code",
          "Vercel",
          "cron-job.org",
          "GitHub and GitHub Actions",
          "Next.js and TypeScript",
          "Python",
        ],
      ],
    ]);
    // ElevenLabs has no card (Listen on a saved basket still uses it), and no tool is listed
    // that we have not confirmed.
    const text = JSON.stringify(groups);
    expect(text).not.toMatch(/ElevenLabs|Codex|Snowflake|Solana|Presage/i);
    for (const card of groups.flatMap((group) => group.cards)) {
      expect(card.role.length).toBeGreaterThan(20);
    }
  });

  it("fills the cards from the live numbers", () => {
    const cards = techGroups(built, savings, now).flatMap((group) => group.cards);
    const stats = (name: string) =>
      Object.fromEntries(
        cards.find((card) => card.name === name)!.stats.map((stat) => [stat.label, stat.value]),
      );
    expect(stats("Google Gemini")).toEqual({
      Models: "gemini-3.5-flash-lite, gemini-3.1-flash-lite",
      "Gemini calls today": "437",
      "Answers reused today": "26.2% (11 of 42)",
    });
    expect(stats("Tiger Data")).toEqual({
      "Odds readings (odds_ticks)": "27,134",
      "Stock closes (stock_closes)": "9,000",
      "Panel decisions": "90",
      "Latest odds reading": "2 minutes ago",
    });
    expect(stats("Polymarket and Kalshi data")).toEqual({
      "Markets tracked": "12",
      Access: "Read-only, no keys",
    });
    expect(stats("Stock prices")).toEqual({
      Source: "Yahoo Finance",
      "Daily closes stored": "9,000",
    });
    // The cron card's proof is the newest tick in Tiger.
    expect(stats("cron-job.org")).toEqual({
      Job: "/api/jobs/tick, every minute",
      "Last tick": "2 minutes ago",
    });
  });

  it("shows a dash, never a guess, when the numbers cannot be read", () => {
    const stats = techGroups(null, null, now).flatMap((group) =>
      group.cards.flatMap((card) => card.stats),
    );
    for (const label of [
      "Gemini calls today",
      "Odds readings (odds_ticks)",
      "Markets tracked",
      "Last tick",
    ]) {
      expect(stats.find((stat) => stat.label === label)?.value).toBe("—");
    }
    expect(stats.some((stat) => /undefined|NaN|null/.test(stat.value))).toBe(false);
  });

  it("draws the pipeline from the idea to the Lab", () => {
    expect(PIPELINE.map((step) => step.title)).toEqual([
      "Your idea",
      "Gemini agent",
      "Polymarket odds",
      "Weights",
      "5 AI votes",
      "Track record",
      "Lab",
    ]);
  });
});
