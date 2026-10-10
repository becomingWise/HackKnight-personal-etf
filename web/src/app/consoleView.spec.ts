// The sentences and small calculations of the test console (track record, Polymarket cards).
import { describe, expect, it } from "vitest";
import {
  agentsByPct,
  driverOf,
  panelSaid,
  paperResult,
  resultOf,
  rightText,
  scopeText,
  verdict,
  versusMarket,
  weekMove,
  yesNo,
  type Decision,
  type Record90,
} from "./consoleView";

const record = (pct: number, range90: [number, number] | null, n = 80): Record90 => ({
  n,
  correct: Math.round((pct / 100) * n),
  pct,
  range90,
  brier: 0.25,
  days: 8,
});
const agent = (name: string, pct: number, range90: [number, number] | null) => ({
  id: name.toLowerCase(),
  agent: name,
  ...record(pct, range90),
});
const decision = (over: Partial<Decision> = {}): Decision => ({
  date: "2026-10-02",
  source: "replay",
  idea: "Oil majors",
  symbols: ["XOM", "CVX", "OXY"],
  yesVotes: 4,
  votes: 5,
  majority: "yes",
  basketPct: 3.02,
  spyPct: 1.16,
  pnl: 302.02,
  correct: true,
  ...over,
});

describe("the track record's wording", () => {
  it("never shows a percentage without its n", () => {
    expect(rightText({ n: 80, correct: 45, pct: 56.3 })).toBe("56% right (45 of 80)");
    expect(rightText({ n: 0, correct: 0, pct: null })).toBe("no scored calls yet");
  });

  it("sorts the agents by their share of right calls", () => {
    const sorted = agentsByPct([agent("Fit", 51.2, null), agent("Skeptic", 57.5, null)]);
    expect(sorted.map((a) => a.agent)).toEqual(["Skeptic", "Fit"]);
  });

  it("says nobody beats a coin flip when every range includes 50%", () => {
    expect(
      verdict({
        agents: [
          agent("Growth investor", 56.3, [48.8, 62.5]),
          agent("Skeptic", 57.5, [47.5, 67.5]),
        ],
        majority: record(50, [37.5, 62.5]),
      }),
    ).toBe("So far, no agent does better than a coin flip: every 90% range includes 50%.");
  });

  it("names whoever is above or below 50% with the whole range", () => {
    const majority = record(50, [37.5, 62.5]);
    expect(
      verdict({
        agents: [agent("Skeptic", 64, [52.5, 75]), agent("Fit checker", 51, [38, 62])],
        majority,
      }),
    ).toBe(
      "So far, Skeptic does better than a coin flip; the others cannot be told apart from one.",
    );
    expect(
      verdict({
        agents: [agent("Skeptic", 64, [52.5, 75]), agent("Macro & events", 66, [55, 77])],
        majority: record(63, [51, 75]),
      }),
    ).toBe("So far, Skeptic, Macro & events and the panel do better than a coin flip.");
    expect(verdict({ agents: [agent("Fit checker", 38, [28, 47.5])], majority })).toBe(
      "So far, no agent does better than a coin flip, and Fit checker does worse.",
    );
  });

  it("does not judge on too little data", () => {
    expect(verdict({ agents: [agent("Skeptic", 60, null)], majority: record(50, null) })).toBe(
      "Too few weeks so far to say whether anyone does better than a coin flip.",
    );
    expect(
      verdict({ agents: [{ ...agent("Skeptic", 0, null), n: 0 }], majority: record(0, null, 0) }),
    ).toBe("No decision has been scored yet.");
  });

  it("counts weeks and decisions", () => {
    const baselines = {
      alwaysYes: record(45, [36, 55]),
      coinFlip: { n: 80, pct: 50, brier: 0.25 },
    };
    expect(scopeText({ decisions: 80, baselines })).toBe("8 weeks, 80 decisions.");
    expect(
      scopeText({
        decisions: 1,
        baselines: { ...baselines, alwaysYes: { ...record(100, null, 1), days: 1 } },
      }),
    ).toBe("1 week, 1 decision.");
  });
});

describe("a decision row", () => {
  it('says "Invest" or "Skip" with the vote count', () => {
    expect(panelSaid(decision())).toEqual({ label: "Invest (4 of 5)", invest: true });
    expect(panelSaid(decision({ yesVotes: 0, majority: "no" }))).toEqual({
      label: "Skip (0 of 5)",
      invest: false,
    });
    expect(panelSaid(decision({ yesVotes: 2, votes: 4, majority: null }))).toEqual({
      label: "No majority (2 of 4)",
      invest: null,
    });
    // An older response without the majority field: 3 of 5 decides.
    expect(panelSaid({ yesVotes: 3, votes: 5 }).label).toBe("Invest (3 of 5)");
    expect(panelSaid({ yesVotes: 2, votes: 5 }).label).toBe("Skip (2 of 5)");
  });

  it("compares the basket with the S&P 500 in points", () => {
    expect(versusMarket(decision())).toEqual({
      points: 1.86,
      text: "+1.86 pts",
      detail: "Basket +3.02%, S&P 500 +1.16%",
    });
    expect(versusMarket(decision({ basketPct: -2.66 }))?.text).toBe("−3.82 pts");
    expect(versusMarket(decision({ basketPct: null, spyPct: null }))).toBeNull();
  });

  it("shows the paper result only where the panel said to invest", () => {
    expect(paperResult(decision())).toBe("made +$302");
    expect(paperResult(decision({ pnl: -1266.28 }))).toBe("lost −$1,266");
    expect(paperResult(decision({ yesVotes: 0, majority: "no" }))).toBeNull();
    expect(paperResult(decision({ pnl: null }))).toBeNull();
  });

  it("is right, wrong or pending", () => {
    expect(resultOf(decision())).toEqual({ text: "✓ Right", tone: "up" });
    expect(resultOf(decision({ correct: false }))).toEqual({ text: "✗ Wrong", tone: "down" });
    expect(resultOf(decision({ basketPct: null, spyPct: null, pnl: null, correct: null }))).toEqual(
      { text: "Pending", tone: "muted" },
    );
    expect(resultOf(decision({ majority: null, correct: null })).text).toBe("No call");
  });
});

describe("a Polymarket card", () => {
  it("shows Yes and No that always add up to 100", () => {
    expect(yesNo(0.18)).toEqual({ yes: 18, no: 82 });
    expect(yesNo(0.105)).toEqual({ yes: 11, no: 89 });
    expect(yesNo(0.004)).toEqual({ yes: 0, no: 100 });
    expect(yesNo(1.2)).toEqual({ yes: 100, no: 0 });
  });

  it("words the 7-day move, and says so when there is none", () => {
    expect(weekMove(0.02)).toEqual({ text: "▲ 2 pts this week", direction: "up" });
    expect(weekMove(-0.015)).toEqual({ text: "▼ 1.5 pts this week", direction: "down" });
    expect(weekMove(0.01).text).toBe("▲ 1 pt this week");
    expect(weekMove(0)).toEqual({ text: "flat this week", direction: "flat" });
    expect(weekMove(null)).toEqual({ text: "no 7-day data", direction: "none" });
    expect(weekMove(undefined).text).toBe("no 7-day data");
  });

  it("names the linked market that moved most as a stock's driver", () => {
    const evidence = [
      { title: "Taiwan", url: "a", probability: 0.1, change7d: 0.005, symbols: ["TSM", "NVDA"] },
      { title: "Chip law", url: "b", probability: 0.2, change7d: -0.13, symbols: ["NVDA"] },
      { title: "No data", url: "c", probability: 0.3, change7d: null, symbols: ["AMD"] },
    ];
    expect(driverOf("NVDA", evidence)?.title).toBe("Chip law");
    expect(driverOf("TSM", evidence)?.title).toBe("Taiwan");
    expect(driverOf("AMD", evidence)?.title).toBe("No data");
    expect(driverOf("JPM", evidence)).toBeNull();
  });
});
