// The replay, the statistics and GET /api/track-record (docs/API.md section 1f). Gemini, the
// database and the clock are mocked.
import { describe, expect, it, vi } from "vitest";
import type { GenerateJson } from "../sponsors/gemini";
import { VOTERS, type PastCalls } from "../votes/votes";
import { decisionOf } from "./decision";
import { buildTrackRecord, createTrackRecordHandler } from "./record";
import {
  REPLAY_IDEAS,
  fridaysEnding,
  runReplay,
  signalAsOf,
  type Basket,
  type OddsHistory,
} from "./replay";
import { CallLimitError, createCachedCalls, memoryCallStore } from "./replayCalls";
import type { NewDecision, RecentDecision, ScoredDecisionRow, ScoredVoteRow } from "./repo";
import { range90ByDay, summarizeCalls, type ScoredCall } from "./stats";

const at = (day: string, hour = 20) => Date.parse(`${day}T${String(hour).padStart(2, "0")}:00:00Z`);

describe("the replay window", () => {
  it("is eight Fridays ending 2026-10-02, and ten ideas over all seven sectors", () => {
    expect(fridaysEnding("2026-10-02", 8)).toEqual([
      "2026-08-14",
      "2026-08-21",
      "2026-08-28",
      "2026-09-04",
      "2026-09-11",
      "2026-09-18",
      "2026-09-25",
      "2026-10-02",
    ]);
    expect(() => fridaysEnding("2026-10-01", 2)).toThrow(/not a Friday/);
    expect(REPLAY_IDEAS).toHaveLength(10);
    expect(new Set(REPLAY_IDEAS).size).toBe(10);
  });
});

describe("odds as of a Friday", () => {
  const history: OddsHistory = {
    id: "taiwan",
    label: "China invades Taiwan",
    question: "Will China invade Taiwan?",
    betas: { TSM: -1 },
    points: [
      [at("2026-08-07", 12), 0.1],
      [at("2026-08-14", 12), 0.125],
      // After the close of 2026-08-14: must never be seen that day.
      [at("2026-08-15", 0), 0.4],
      [at("2026-08-21", 12), 0.2],
    ],
  };

  it("uses the last price up to the close and the change against a week earlier", () => {
    const signal = signalAsOf(history, "2026-08-14")!;
    expect(signal.price).toBe(0.125);
    expect(signal.changes?.["1w"]).toBeCloseTo(0.025);
    expect(signal).toMatchObject({ id: "taiwan", status: "live", betas: { TSM: -1 } });
    // A week later the later prices are known, the ones after that Friday still are not.
    expect(signalAsOf(history, "2026-08-21")!.price).toBe(0.2);
  });

  it("leaves out a market that did not exist yet, and reports an unknown change", () => {
    const young: OddsHistory = { ...history, points: [[at("2026-08-20", 12), 0.3]] };
    expect(signalAsOf(young, "2026-08-14")).toBeNull();
    expect(signalAsOf(young, "2026-08-21")).toMatchObject({ price: 0.3, changes: { "1w": null } });
    // A price from long before is not "the odds that day".
    expect(signalAsOf(young, "2026-09-04")).toBeNull();
    expect(signalAsOf({ ...history, points: [] }, "2026-08-14")).toBeNull();
  });
});

describe("the replay", () => {
  const baskets: Basket[] = [
    { idea: "AI chips", stocks: [{ symbol: "TSM", name: "Taiwan Semiconductor" }] },
    { idea: "Banks", stocks: [{ symbol: "JPM", name: "JPMorgan Chase" }] },
  ];
  const histories: OddsHistory[] = [
    {
      id: "taiwan",
      label: "China invades Taiwan",
      question: "Will China invade Taiwan?",
      betas: { TSM: -1 },
      points: [
        [at("2026-09-18", 12), 0.1],
        [at("2026-09-25", 12), 0.12],
        [at("2026-10-02", 12), 0.3],
      ],
    },
  ];
  const answer = {
    baskets: [
      {
        basket: 1,
        votes: [{ symbol: "TSM", vote: "yes", reason: "Fits." }],
        beatsSpy: { probability: 0.6, vote: "yes", reason: "Momentum." },
      },
      {
        basket: 2,
        votes: [{ symbol: "JPM", vote: "yes", reason: "A bank." }],
        beatsSpy: { probability: 0.4, vote: "no", reason: "Rates." },
      },
    ],
  };

  function setup(limit = 100) {
    const generate = vi.fn<GenerateJson>(async (args) => {
      args.onAttempt?.("gemini-3.5-flash-lite");
      args.onModel?.("gemini-3.5-flash-lite");
      return answer;
    });
    const store = memoryCallStore();
    const saved: NewDecision[] = [];
    const prices = vi.fn(async (_symbols: string[], day: string) => ({
      asOf: day,
      spy: { r5: 0.01, r20: 0.02 },
      returns: { TSM: { r5: 0.03, r20: 0.04 }, JPM: { r5: -0.01, r20: 0 } },
    }));
    const past = vi.fn(async (day: string): Promise<Record<string, PastCalls>> =>
      day === "2026-10-02" ? { growth: { n: 2, correct: 1 } } : {},
    );
    const score = vi.fn(async () => 2);
    const run = (fridays: string[], max = limit) =>
      runReplay({
        baskets,
        fridays,
        histories,
        calls: createCachedCalls({ generate, store, limit: max, sleep: async () => {} }),
        prices,
        past,
        save: async (decision) => void saved.push(decision),
        score,
      });
    return { generate, store, saved, prices, past, score, run };
  }

  it("asks each agent once per Friday with every basket, using only that Friday's data", async () => {
    const t = setup();
    const result = await t.run(["2026-09-25", "2026-10-02"]);
    expect(result).toEqual({ fridays: 2, decisions: 4, missingAnswers: 0 });
    expect(t.generate).toHaveBeenCalledTimes(10);
    expect(t.prices.mock.calls.map(([, day]) => day)).toEqual(["2026-09-25", "2026-10-02"]);
    expect(t.past.mock.calls.map(([day]) => day)).toEqual(["2026-09-25", "2026-10-02"]);
    expect(t.score).toHaveBeenCalledTimes(2);

    const prompts = t.generate.mock.calls.map(([args]) => args.prompt);
    const firstMacro = prompts[2];
    expect(firstMacro).toContain("DATA AS OF 2026-09-25");
    expect(firstMacro).toContain("BASKET 1");
    expect(firstMacro).toContain("BASKET 2");
    // The odds of 25 September and their move since the 18th; the 30% of October is unknown.
    expect(firstMacro).toContain('"Will China invade Taiwan?": Yes 12%, +2 pts over 7 days');
    expect(prompts.slice(0, 5).some((p) => p.includes("30%"))).toBe(false);
    expect(prompts[7]).toContain("Yes 30%, +18 pts over 7 days");
    // The same system prompts and model split as the live panel.
    expect(t.generate.mock.calls.slice(0, 5).map(([args]) => args.system)).toEqual(
      VOTERS.map((v) => v.system),
    );
    expect(t.generate.mock.calls.slice(0, 5).map(([args]) => args.task)).toEqual([
      "voteA",
      "voteB",
      "voteA",
      "voteB",
      "voteA",
    ]);
    // An agent hears about its record only once earlier weeks are scored.
    expect(prompts.slice(0, 5).some((p) => p.includes("Your past calls"))).toBe(false);
    expect(prompts[5]).toContain("Your past calls: 1 of 2 right (50%).");
    expect(prompts[6]).not.toContain("Your past calls");

    expect(t.saved).toHaveLength(4);
    expect(t.saved[0]).toMatchObject({
      day: "2026-09-25",
      source: "replay",
      idea: "AI chips",
      symbols: ["TSM"],
      majority: "yes",
      inputs: {
        signals: [{ id: "taiwan", probability: 0.12 }],
        returns: { SPY: { r5: 0.01, r20: 0.02 }, TSM: { r5: 0.03, r20: 0.04 } },
      },
    });
    expect(t.saved[1]).toMatchObject({ idea: "Banks", majority: "no", inputs: { signals: [] } });
    expect(t.saved[0].votes).toHaveLength(5);
  });

  it("costs nothing the second time", async () => {
    const t = setup();
    await t.run(["2026-09-25", "2026-10-02"]);
    await t.run(["2026-09-25", "2026-10-02"], 0);
    expect(t.generate).toHaveBeenCalledTimes(10);
    expect(await t.store.spent()).toBe(10);
  });

  it("stops at the call limit instead of going over it", async () => {
    const t = setup(7);
    await expect(t.run(["2026-09-25", "2026-10-02"])).rejects.toBeInstanceOf(CallLimitError);
    expect(t.generate).toHaveBeenCalledTimes(7);
    expect(await t.store.spent()).toBe(7);
    // The first Friday was complete and is saved; the unfinished one is not.
    expect(t.saved.map((d) => d.day)).toEqual(["2026-09-25", "2026-09-25"]);
  });

  it("keeps going when one agent fails, and saves the others' calls", async () => {
    const t = setup();
    t.generate.mockImplementationOnce(async () => {
      throw new Error("timeout");
    });
    const result = await t.run(["2026-09-25"]);
    expect(result.missingAnswers).toBe(1);
    expect(t.saved[0].votes.map((v) => v.agent)).toEqual(["value", "macro", "skeptic", "fit"]);
  });
});

describe("a saved decision", () => {
  const basket = {
    idea: "AI chips",
    stocks: [{ symbol: "TSM", name: "Taiwan Semiconductor" }],
    evidence: [],
    returns: { TSM: { r5: 0.01, r20: 0.02 } },
  };
  const yes = {
    stocks: new Map(),
    call: { vote: "yes" as const, probability: 0.6, reason: "Up." },
  };
  const no = {
    stocks: new Map(),
    call: { vote: "no" as const, probability: 0.3, reason: "Down." },
  };

  it("needs a close to count from and at least one call; the majority is 3 of 5", () => {
    const context = { asOf: "2026-10-09", spy: null };
    const input = { source: "live" as const, basket, context, signals: [] };
    expect(decisionOf({ ...input, answers: [yes, yes, no, no, null] })?.majority).toBeNull();
    expect(decisionOf({ ...input, answers: [yes, no, no, no, null] })?.majority).toBe("no");
    expect(decisionOf({ ...input, answers: [null, null, null, null, null] })).toBeNull();
    expect(
      decisionOf({
        ...input,
        context: { asOf: null, spy: null },
        answers: [yes, yes, yes, no, no],
      }),
    ).toBeNull();
  });
});

describe("the statistics", () => {
  const calls = (day: string, right: number, wrong: number, probability = 0.6): ScoredCall[] => [
    ...Array.from({ length: right }, () => ({ day, correct: true, probability, beat: true })),
    ...Array.from({ length: wrong }, () => ({ day, correct: false, probability, beat: false })),
  ];

  it("gives n, correct, % and the Brier score", () => {
    const record = summarizeCalls([...calls("2026-09-25", 3, 1), ...calls("2026-10-02", 1, 3)]);
    expect(record).toMatchObject({ n: 8, correct: 4, pct: 50, days: 2 });
    // Right calls: (0.6 - 1)^2 = 0.16; wrong ones: (0.6 - 0)^2 = 0.36.
    expect(record.brier).toBe(0.26);
    expect(summarizeCalls([])).toEqual({
      n: 0,
      correct: 0,
      pct: null,
      range90: null,
      brier: null,
      days: 0,
    });
  });

  it("resamples whole Fridays for the 90% range, and is the same every time", () => {
    // Two all-or-nothing weeks: resampling days can give 0%, 50% or 100%.
    const clustered = [...calls("2026-09-25", 10, 0), ...calls("2026-10-02", 0, 10)];
    expect(range90ByDay(clustered)).toEqual([0, 100]);
    expect(range90ByDay(clustered)).toEqual(range90ByDay(clustered));
    // The same 10 of 20, spread evenly over ten days, is far more certain.
    const spread = Array.from({ length: 10 }, (_, i) => calls(`2026-08-${10 + i}`, 1, 1)).flat();
    expect(range90ByDay(spread)).toEqual([50, 50]);
    // One day cannot be resampled.
    expect(range90ByDay(calls("2026-10-02", 3, 2))).toBeNull();
  });
});

describe("GET /api/track-record", () => {
  const decisions: ScoredDecisionRow[] = [
    { decisionId: "1", day: "2026-09-25", majority: "yes", majorityCorrect: true, beat: true },
    { decisionId: "2", day: "2026-09-25", majority: "yes", majorityCorrect: false, beat: false },
    { decisionId: "3", day: "2026-10-02", majority: null, majorityCorrect: null, beat: true },
  ];
  const votes: ScoredVoteRow[] = decisions.flatMap((decision) =>
    VOTERS.map((voter, index) => {
      const yes = index < 3;
      return {
        decisionId: decision.decisionId,
        day: decision.day,
        agent: voter.id,
        probability: yes ? 0.7 : 0.3,
        correct: yes === decision.beat,
        beat: decision.beat,
      };
    }),
  );
  const recent: RecentDecision[] = [
    {
      date: "2026-10-09",
      source: "live",
      idea: "AI chips",
      symbols: ["NVDA", "TSM", "AMD"],
      yesVotes: 4,
      votes: 5,
      majority: "yes",
      basketPct: null,
      spyPct: null,
      pnl: null,
      correct: null,
    },
  ];
  const record = buildTrackRecord(
    { votes, decisions, pending: 1, lastClose: "2026-10-09" },
    recent,
    new Date("2026-10-10T18:00:00Z"),
  );

  it("reports every agent and the majority with n next to the percentage", () => {
    expect(record).toMatchObject({ decisions: 3, pending: 1, lastClose: "2026-10-09" });
    expect(record.agents.map((a) => [a.id, a.n, a.correct, a.pct])).toEqual([
      ["growth", 3, 2, 66.7],
      ["value", 3, 2, 66.7],
      ["macro", 3, 2, 66.7],
      ["skeptic", 3, 1, 33.3],
      ["fit", 3, 1, 33.3],
    ]);
    expect(record.agents[0].days).toBe(2);
    expect(record.agents[0].range90).not.toBeNull();
    // The tie on 2 October has no majority, so it is not one of the majority's calls.
    expect(record.majority).toMatchObject({ n: 2, correct: 1, pct: 50 });
    // Mean probability of the five agents: (3 * 0.7 + 2 * 0.3) / 5 = 0.54.
    expect(record.majority.brier).toBe(0.252);
  });

  it('compares with "always yes" and a coin flip', () => {
    expect(record.baselines.alwaysYes).toMatchObject({ n: 3, correct: 2, pct: 66.7, brier: 0.333 });
    expect(record.baselines.coinFlip).toEqual({ n: 3, pct: 50, brier: 0.25 });
    expect(record.recent).toEqual(recent);
  });

  it("serves the record, and 503 when it cannot be read", async () => {
    const request = new Request("https://prophetf.vercel.app/api/track-record");
    const ok = await createTrackRecordHandler({ load: async () => record }).GET(request);
    expect(ok.status).toBe(200);
    expect(Object.keys(await ok.json())).toEqual([
      "generatedAt",
      "question",
      "lastClose",
      "decisions",
      "pending",
      "agents",
      "majority",
      "baselines",
      "recent",
    ]);
    const failing = await createTrackRecordHandler({
      load: async () => {
        throw new Error("db down");
      },
    }).GET(request);
    expect(failing.status).toBe(503);
  });
});
