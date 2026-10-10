// The decision workflow (analyst → gate → decider → checker) and its three endpoints, with
// Gemini and Polymarket mocked. Contract: docs/API.md sections 1, 1b and 1c.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createMockAnalyst } from "../analyst/mock";
import { evidencePacketSchema, type EvidencePacket } from "../analyst/packet";
import { createTigerAnalyst } from "../analyst/tiger";
import type { MarketCandidate } from "../polymarket/search";
import type { GenerateJson } from "../sponsors/gemini";
import { formatOdds, oddsAreAccurate, responseSchema } from "../stocks/contract";
import { SYMBOLS } from "../stocks/universe";
import { check, quotedPoints, ungroundedNumbers } from "./checker";
import { EVAL_CASES } from "./evalCases";
import { GATE, gate } from "./gate";
import {
  computeStocks,
  createAnalyzeHandler,
  createDecideHandler,
  createStocksHandler,
  type HandlerDeps,
} from "./handler";
import { analystMode, fallbackFromPacket } from "./run";

const NOW = new Date("2026-10-10T12:00:00Z");

const market = (over: Partial<MarketCandidate>): MarketCandidate => ({
  id: "1811266",
  question: "Will China invade Taiwan by June 30, 2027?",
  eventTitle: "Will China invade Taiwan by June 30, 2027?",
  url: "https://polymarket.com/event/will-china-invade-taiwan-by-june-30-2027",
  probability: 0.075,
  change7d: -0.01,
  change24h: 0.002,
  endDate: "2027-07-01T03:59:00Z",
  volume: 472728,
  volume24h: 31000,
  liquidity: 250000,
  yesTokenId: "tok-yes",
  linkedSymbols: [],
  ...over,
});

const TAIWAN = market({});
const CHIPS = market({
  id: "900001",
  question: "Will AI-chip export licensing become law this year?",
  eventTitle: "AI chips export licensing",
  url: "https://polymarket.com/event/ai-chip-export-licensing",
  probability: 0.22,
  change7d: 0.03,
});

const search = async (query: string) => (/taiwan/i.test(query) ? [TAIWAN] : [CHIPS]);

const GOOD = {
  summary: "Chip makers are exposed to Taiwan risk and to export rules, so these markets matter.",
  stocks: [
    {
      symbol: "TSM",
      marketIds: ["1811266"],
      reason:
        "Polymarket gives 7.5% that China invades Taiwan by mid-2027, the key risk for TSMC's fabs.",
    },
    {
      symbol: "NVDA",
      marketIds: ["900001"],
      reason:
        "Polymarket gives 22% that AI-chip export licensing becomes law, which would cap NVIDIA's sales.",
    },
    {
      symbol: "INTC",
      marketIds: ["1811266", "900001"],
      reason:
        "With invasion odds at 7.5% and licensing at 22%, Intel's domestic fabs are a hedge on both.",
    },
  ],
};

const withStock = (index: number, change: Record<string, unknown>) => ({
  ...GOOD,
  stocks: GOOD.stocks.map((s, i) => (i === index ? { ...s, ...change } : s)),
});

/** A Gemini mock that returns the given answers in order (the last one repeats). */
function gemini(...answers: unknown[]): GenerateJson & ReturnType<typeof vi.fn> {
  let call = 0;
  return vi.fn(async () => {
    const answer = answers[Math.min(call++, answers.length - 1)];
    if (answer instanceof Error) throw answer;
    return answer;
  }) as never;
}

function deps(generate: GenerateJson, over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    generate,
    search,
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    mode: "mock",
    checkerLlm: false,
    now: () => NOW,
    ...over,
  };
}

function post(body: unknown, headers: Record<string, string> = {}, route = "stocks") {
  return new Request(`https://api.test/api/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** The exact rules of validateStocks in js/controller.js. */
function expectContractShape(body: unknown) {
  const parsed = responseSchema.parse(body);
  expect(typeof parsed.summary).toBe("string");
  expect(parsed.stocks.length).toBeGreaterThanOrEqual(3);
  expect(parsed.stocks.length).toBeLessThanOrEqual(5);
  expect(new Set(parsed.stocks.map((s) => s.symbol)).size).toBe(parsed.stocks.length);
  for (const stock of parsed.stocks) {
    expect(SYMBOLS).toContain(stock.symbol);
    expect(stock.name.trim()).not.toBe("");
    expect(stock.reason.trim()).not.toBe("");
    // The contract forbids allocation percentages and prices on this port.
    expect(stock).not.toHaveProperty("weight");
    expect(stock).not.toHaveProperty("weightPct");
    expect(stock).not.toHaveProperty("price");
  }
  return parsed;
}

const traceOf = (body: { trace?: { step: string; status: string; summary: string }[] }) =>
  Object.fromEntries((body.trace ?? []).map((t) => [t.step, t]));

async function mockPacket(idea = "AI chips and Taiwan risk"): Promise<EvidencePacket> {
  return createMockAnalyst({ search, now: () => NOW })(idea);
}

describe("POST /api/stocks", () => {
  it("returns the unchanged contract plus a trace, with one Gemini call", async () => {
    const generate = gemini(GOOD);
    const { POST } = createStocksHandler(deps(generate));
    const res = await POST(post({ idea: "  AI chips and Taiwan risk " }));
    expect(res.status).toBe(200);
    const body = expectContractShape(await res.json());

    expect(generate).toHaveBeenCalledTimes(1);
    expect(body.source).toBe("gemini");
    expect(body.stocks.map((s) => s.symbol)).toEqual(["TSM", "NVDA", "INTC"]);
    expect(body.stocks[0]).toMatchObject({ name: "Taiwan Semiconductor", marketId: "1811266" });
    expect(body.stocks[0].reason).toContain("7.5%");
    // Summary carries the key odds, appended by the server from the packet.
    expect(body.summary).toContain('"Will China invade Taiwan by June 30, 2027?" 7.5%');
    expect(body.markets.map((m) => m.id).sort()).toEqual(["1811266", "900001"]);
    expect(body.markets[0]).toMatchObject({ outcome: "Yes", observedAt: NOW.toISOString() });

    expect(body.trace!.map((t) => t.step)).toEqual(["analyst", "gate", "decider", "checker"]);
    const trace = traceOf(body);
    expect(trace.analyst.summary).toMatch(/^2 markets, \d+ themes, \d+ ticker signals \(mock\)$/);
    expect(trace.gate).toMatchObject({ status: "ok", summary: "passed: 2 of 2 markets usable" });
    expect(trace.decider.summary).toBe("3 stocks (1 Gemini call)");
    expect(trace.checker).toMatchObject({ status: "ok", summary: "passed, no revision" });
  });

  it("sends the checker's errors back for one revision when a market id is made up", async () => {
    const generate = gemini(withStock(0, { marketIds: ["424242"] }), GOOD);
    const { POST } = createStocksHandler(deps(generate));
    const body = expectContractShape(await (await POST(post({ idea: "chips" }))).json());

    expect(generate).toHaveBeenCalledTimes(2);
    const revision = generate.mock.calls[1][0].prompt as string;
    expect(revision).toContain("The checker rejected it:");
    expect(revision).toContain("TSM cites market id 424242, which is not in the packet.");
    expect(revision).toContain('"marketIds":["424242"]'); // its previous answer
    expect(body.source).toBe("gemini");
    expect(traceOf(body).checker).toMatchObject({ status: "warn", summary: "passed, 1 revision" });
    expect(body.markets.every((m) => ["1811266", "900001"].includes(m.id))).toBe(true);
  });

  it("never asks for a second revision: it keeps the stocks that pass and drops the rest", async () => {
    const four = {
      ...GOOD,
      stocks: [
        ...GOOD.stocks,
        { symbol: "AMD", marketIds: ["900001"], reason: "Polymarket gives 60% to licensing." },
      ],
    };
    const generate = gemini(four);
    const { POST } = createStocksHandler(deps(generate));
    const body = expectContractShape(await (await POST(post({ idea: "taiwan chips" }))).json());

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].prompt).toContain(
      "AMD: the reason says 60% but its cited markets are at 22% Yes (id 900001).",
    );
    expect(body.stocks.map((s) => s.symbol)).toEqual(["TSM", "NVDA", "INTC"]);
    expect(traceOf(body).checker.summary).toBe(
      "1 revision; kept the 3 stocks that pass, dropped the rest",
    );
  });

  it("answers from the evidence alone when Gemini fails, citing a market for every stock", async () => {
    const generate = gemini(new Error("503 overloaded"));
    const { POST } = createStocksHandler(deps(generate));
    const res = await POST(post({ idea: "I believe in semiconductor chips" }));
    expect(res.status).toBe(200);
    const body = expectContractShape(await res.json());

    expect(generate).toHaveBeenCalledTimes(2);
    expect(generate.mock.calls[1][0].prefer).toBe("lite");
    expect(body.source).toBe("fallback");
    expect(body.summary).toMatch(/evidence-only selection/i);
    for (const stock of body.stocks) {
      expect(stock.marketId).not.toBeNull();
      expect(stock.reason).toMatch(/^Polymarket gives (7\.5|22)% to "/);
    }
    expect(traceOf(body).decider).toMatchObject({ status: "failed" });
  });

  it("falls back when Gemini keeps returning invalid output", async () => {
    const { POST } = createStocksHandler(deps(gemini({ nonsense: true })));
    const body = expectContractShape(await (await POST(post({ idea: "taiwan chips" }))).json());
    expect(body.source).toBe("fallback");
    expect(traceOf(body).decider.summary).toBe("answer rejected after 2 Gemini calls");
  });

  it("stops at the gate with 422 and never calls Gemini when there is not enough evidence", async () => {
    const generate = gemini(GOOD);
    const { POST } = createStocksHandler(deps(generate, { search: async () => [TAIWAN] }));
    const res = await POST(post({ idea: "zzzz qqqq" }));
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.error).toEqual({ code: "not_enough_evidence", message: expect.any(String) });
    expect(traceOf(body).gate).toMatchObject({
      status: "failed",
      summary:
        "not enough evidence: 0 of 1 markets usable (1 not relevant, 0 illiquid, 0 ended), need 2",
    });
    expect(traceOf(body).decider.status).toBe("skipped");
    expect(generate).not.toHaveBeenCalled();
  });

  it("answers 502 instead of inventing a basket when Gemini is down and no ticker is linked", async () => {
    const unlinked = async () => [
      market({ id: "1", question: "Will the zebra migration start early?" }),
      market({ id: "2", question: "Will the zebra migration cross the river?" }),
    ];
    const { POST } = createStocksHandler(deps(gemini(new Error("down")), { search: unlinked }));
    const res = await POST(post({ idea: "zebra migration" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: "no_match", message: expect.any(String) } });
  });

  it("skips the decider when the per-minute Gemini budget is used up", async () => {
    const generate = gemini(GOOD);
    const { POST } = createStocksHandler(
      deps(generate, {
        rateLimit: async (limits) => ({
          allowed: !limits.some((l) => l.bucket === "decider:minute"),
          retryAfterSeconds: 30,
        }),
      }),
    );
    const body = expectContractShape(await (await POST(post({ idea: "chips" }))).json());
    expect(generate).not.toHaveBeenCalled();
    expect(body.source).toBe("fallback");
    expect(traceOf(body).decider).toMatchObject({
      status: "skipped",
      summary: "skipped: the per-minute Gemini budget is used up",
    });
  });

  it("adds one LLM review call when CHECKER_LLM is on, and revises once on its findings", async () => {
    const generate = gemini(
      GOOD,
      { issues: [{ symbol: "INTC", problem: "The link is vague." }] },
      GOOD,
    );
    const { POST } = createStocksHandler(deps(generate, { checkerLlm: true }));
    const body = expectContractShape(await (await POST(post({ idea: "chips" }))).json());
    expect(generate).toHaveBeenCalledTimes(3); // decision, review, revision
    expect(generate.mock.calls[2][0].prompt).toContain("- INTC: The link is vague.");
    expect(traceOf(body).checker.summary).toBe("passed, 1 revision, LLM review on");
  });

  it.each([
    ["missing idea", {}],
    ["empty idea", { idea: "   " }],
    ["non-string idea", { idea: 42 }],
    ["too long", { idea: "x".repeat(501) }],
    ["not JSON", "{oops"],
  ])("rejects an invalid request (%s) with 400 and the error shape", async (_name, payload) => {
    const generate = gemini(GOOD);
    const { POST } = createStocksHandler(deps(generate));
    const res = await POST(post(payload));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "invalid_request", message: expect.any(String) } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the rate limit is hit, without calling Gemini", async () => {
    const generate = gemini(GOOD);
    const { POST } = createStocksHandler(
      deps(generate, { rateLimit: async () => ({ allowed: false, retryAfterSeconds: 42 }) }),
    );
    const res = await POST(post({ idea: "unique rate limited idea" }));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("42");
    expect((await res.json()).error.code).toBe("rate_limited");
    expect(generate).not.toHaveBeenCalled();
  });

  it("sends CORS headers to the frontend origins only, and answers the preflight", async () => {
    const { POST, OPTIONS } = createStocksHandler(deps(gemini(GOOD)));
    const pages = "https://becomingwise.github.io";

    const pre = OPTIONS(
      new Request("https://api.test/api/stocks", { method: "OPTIONS", headers: { Origin: pages } }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(pages);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("POST");

    const ok = await POST(post({ idea: "chips" }, { Origin: "http://127.0.0.1:8000" }));
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:8000");
    const bad = await POST(post({ idea: "" }, { Origin: pages }));
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBe(pages);
    const other = await POST(post({ idea: "chips" }, { Origin: "https://evil.example" }));
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("POST /api/analyze and POST /api/decide", () => {
  it("returns a valid packet that /api/decide turns into the /api/stocks answer", async () => {
    const generate = gemini(GOOD);
    const analyzed = await createAnalyzeHandler(deps(generate)).POST(
      post({ idea: "AI chips and Taiwan risk" }, {}, "analyze"),
    );
    expect(analyzed.status).toBe(200);
    const { packet, gate: gated, trace } = await analyzed.json();
    expect(evidencePacketSchema.safeParse(packet).success).toBe(true);
    expect(gated).toEqual({ passed: true, summary: "passed: 2 of 2 markets usable" });
    expect(trace.map((t: { step: string }) => t.step)).toEqual(["analyst", "gate"]);
    expect(generate).not.toHaveBeenCalled();

    const decided = await createDecideHandler(deps(generate)).POST(
      post({ idea: "AI chips and Taiwan risk", packet }, {}, "decide"),
    );
    expect(decided.status).toBe(200);
    const body = expectContractShape(await decided.json());
    expect(body.trace!.map((t) => t.step)).toEqual(["gate", "decider", "checker"]);
    expect(generate).toHaveBeenCalledTimes(1);
    // The decider saw the packet's markets and the allowed tickers.
    const prompt = generate.mock.calls[0][0].prompt as string;
    expect(prompt).toContain('id 1811266: "Will China invade Taiwan by June 30, 2027?" | Yes 7.5%');
    expect(prompt).toContain("7d -1.0 pts");
    expect(prompt).toContain("TSM (Taiwan Semiconductor)");
  });

  it("rejects a packet that breaks the contract, naming the field", async () => {
    const packet = await mockPacket();
    const broken = {
      ...packet,
      themes: [{ name: "x", direction: "up", confidence: 2, marketIds: [] }],
    };
    const res = await createDecideHandler(deps(gemini(GOOD))).POST(
      post({ idea: "chips", packet: broken }, {}, "decide"),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error.message).toMatch(/^packet\.themes\.0\./);
  });

  it("refuses a stale packet at the gate", async () => {
    const packet = { ...(await mockPacket()), generatedAt: "2026-10-10T10:00:00Z" };
    const generate = gemini(GOOD);
    const res = await createDecideHandler(deps(generate)).POST(
      post({ idea: "chips", packet }, {}, "decide"),
    );
    expect(res.status).toBe(422);
    expect((await res.json()).trace[0].summary).toContain("120 minutes old");
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("the workflow with the team's real controller", () => {
  const controllerPath = path.resolve(process.cwd(), "..", "js", "controller.js");

  it.skipIf(!existsSync(controllerPath))(
    "passes validateStocks and opens the dashboard",
    async () => {
      const { createController } = await import(
        /* @vite-ignore */ pathToFileURL(controllerPath).href
      );
      const controller = createController({
        findStocks: ({ idea }: { idea: string }) => computeStocks(idea, deps(gemini(GOOD))),
        adjustWeights: async ({ holdings }: { holdings: unknown[] }) => ({
          status: "unchanged",
          holdings,
          explanation: "No adjustment in this test.",
          evidence: [],
        }),
      });
      await controller.submitIdea("AI chips and Taiwan risk");
      const state = controller.getState();
      expect(state.error).toBeNull();
      expect(state.view).toBe("dashboard");
      expect(state.stocks).toEqual([
        { symbol: "TSM", name: "Taiwan Semiconductor", reason: expect.stringContaining("7.5%") },
        { symbol: "NVDA", name: "NVIDIA", reason: expect.stringContaining("22%") },
        { symbol: "INTC", name: "Intel", reason: expect.any(String) },
      ]);
      expect(state.summary).toContain("Key Polymarket odds");
    },
  );
});

describe("analyst", () => {
  it("builds a packet from search, universe links and Tiger history", async () => {
    const analyst = createMockAnalyst({
      search,
      now: () => NOW,
      pastOdds: async () => new Map([["1811266", { d1: null, d7: 0.125 }]]),
    });
    const packet = evidencePacketSchema.parse(await analyst("AI chips and Taiwan risk"));
    const taiwan = packet.markets.find((m) => m.id === "1811266")!;
    // 7 days from Tiger (7.5% now, 12.5% then); 24 hours from Polymarket's own field.
    expect(taiwan).toMatchObject({ change7d: -0.05, change24h: 0.002, liquidity: 250000 });
    expect(taiwan.relevance).toBeGreaterThanOrEqual(0.5);
    // TSM's sensitivity to an invasion is -1: falling odds are good for it.
    expect(packet.tickerSignals.find((t) => t.symbol === "TSM")).toMatchObject({
      impact: 0.5,
      marketIds: expect.arrayContaining(["1811266"]),
    });
    expect(packet.themes.map((t) => t.name)).toContain("Semiconductors");
    expect(packet.warnings[0]).toMatch(/mock analyst/i);
  });

  it("uses the module analyst when asked, and the mock when it fails", async () => {
    const custom = { ...(await mockPacket()), warnings: ["from the real analyst"] };
    const used = createAnalyzeHandler(
      deps(gemini(GOOD), { mode: "module", analysts: { module: async () => custom } }),
    );
    const ok = await (await used.POST(post({ idea: "chips" }, {}, "analyze"))).json();
    expect(ok.packet.warnings).toEqual(["from the real analyst"]);
    expect(ok.trace[0]).toMatchObject({
      status: "ok",
      summary: expect.stringContaining("(module)"),
    });

    // The placeholder in src/lib/analyst/index.ts throws until the teammate writes it.
    const failing = createAnalyzeHandler(deps(gemini(GOOD), { mode: "module" }));
    const body = await (await failing.POST(post({ idea: "chips" }, {}, "analyze"))).json();
    expect(body.trace[0]).toMatchObject({
      status: "warn",
      summary: expect.stringContaining("(mock); the module analyst failed"),
    });
    expect(body.packet.warnings[0]).toContain("The module analyst failed");
  });

  it("reads Tiger: a stored packet as is, otherwise the analyst's notes over the mock's search", async () => {
    const stored = { ...(await mockPacket()), warnings: ["stored"] };
    const withPacket = createTigerAnalyst(
      { search, now: () => NOW },
      { latestPacket: async () => stored, marketAnalyses: async () => new Map() },
    );
    expect((await withPacket("AI chips and Taiwan risk")).warnings).toEqual(["stored"]);

    const overlay = createTigerAnalyst(
      { search, now: () => NOW },
      {
        latestPacket: async () => null,
        marketAnalyses: async () =>
          new Map([
            [
              "900001",
              {
                signal: "bearish" as const,
                analystNote: "Licensing would hit data-center sales.",
                tickers: [{ symbol: "NVDA", impact: -0.7, why: "Most exposed to export rules." }],
              },
            ],
          ]),
      },
    );
    const packet = evidencePacketSchema.parse(await overlay("AI chips and Taiwan risk"));
    expect(packet.markets.find((m) => m.id === "900001")).toMatchObject({
      signal: "bearish",
      analystNote: "Licensing would hit data-center sales.",
    });
    expect(packet.tickerSignals.find((t) => t.symbol === "NVDA")!.why).toBe(
      "Most exposed to export rules.",
    );
  });

  it("reads ANALYST_MODE, defaulting to mock", () => {
    expect(analystMode(undefined)).toBe("mock");
    expect(analystMode("Tiger")).toBe("tiger");
    expect(analystMode("module")).toBe("module");
    expect(analystMode("nonsense")).toBe("mock");
  });
});

describe("gate", () => {
  it("counts only relevant, liquid, open markets and prunes the packet to them", async () => {
    const packet = await mockPacket();
    const mixed: EvidencePacket = {
      ...packet,
      markets: [
        ...packet.markets,
        { ...packet.markets[0], id: "low", relevance: GATE.minRelevance - 0.01 },
        { ...packet.markets[0], id: "thin", liquidity: 10 },
        { ...packet.markets[0], id: "unknown", liquidity: null },
        { ...packet.markets[0], id: "over", endDate: "2026-10-01T00:00:00Z" },
      ],
      tickerSignals: [
        ...packet.tickerSignals,
        { symbol: "ZZZ", impact: 0.2, marketIds: ["thin", "over"], why: "x" },
      ],
    };
    const result = gate(mixed, NOW);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      "passed: 2 of 6 markets usable (1 not relevant, 2 illiquid, 1 ended)",
    );
    expect(result.packet.markets.map((m) => m.id).sort()).toEqual(["1811266", "900001"]);
    expect(result.packet.tickerSignals.some((t) => t.symbol === "ZZZ")).toBe(false);
    expect(evidencePacketSchema.safeParse(result.packet).success).toBe(true);
  });
});

describe("checker", () => {
  it("reports every broken rule in words the decider can act on", async () => {
    const packet = await mockPacket();
    const result = check(
      {
        summary: "Chips are exposed, with odds at 7.5% for Taiwan.",
        stocks: [
          GOOD.stocks[0],
          { ...GOOD.stocks[0] },
          { symbol: "TSLA", marketIds: ["900001"], reason: "Polymarket gives 22% to licensing." },
          { symbol: "AMD", marketIds: [], reason: "AMD sells AI chips and is exposed to rules." },
          { symbol: "MU", marketIds: ["900001"], reason: "Memory demand follows AI chip sales." },
          {
            symbol: "ASML",
            marketIds: ["900001"],
            reason: "Polymarket gives 22% to licensing, up 9 pts this week.",
          },
        ],
      },
      packet,
    );
    expect(result.errors).toEqual([
      "TSM appears more than once.",
      "TSLA is not in the allowed list.",
      "AMD cites no market; every stock needs at least one packet market id.",
      "MU: the reason must quote the odds of a cited market (22% Yes (id 900001)).",
      "ASML: the reason mentions a move of 9 points that its cited markets do not show.",
      "Pick 3 to 5 stocks; the answer has 6.",
      "The summary must not contain percentages.",
    ]);
    expect(result.stocks.map((s) => s.symbol)).toEqual(["TSM"]);
    expect(result.summary).toBeNull();
  });

  it("accepts No odds, exact moves in points, and a percentage quoted from the question", async () => {
    const packet = await mockPacket();
    packet.markets[0].question = "Will tariffs on chips reach 25% this year?";
    const [m] = packet.markets;
    const yes = formatOdds(m.probability);
    const no = formatOdds(1 - m.probability);
    const move = Math.abs(m.change7d! * 100).toFixed(1);
    const reason = `Polymarket gives ${yes}% (so ${no}% against) to 25% tariffs, a move of ${move} points in 7 days.`;
    const stocks = ["TSM", "NVDA", "AMD"].map((symbol) => ({ symbol, marketIds: [m.id], reason }));
    expect(check({ summary: "Chip makers and tariffs.", stocks }, packet).errors).toEqual([]);
    expect(ungroundedNumbers(stocks[0], packet)).toEqual([]);
  });

  it("finds numbers that no evidence backs", async () => {
    const packet = await mockPacket();
    expect(quotedPoints("up 1.2 pts, then 3 percentage points, 5 points")).toEqual([1.2, 3, 5]);
    const stock = {
      symbol: "TSM",
      marketIds: ["1811266"],
      reason:
        "Polymarket gives 7.5% to an invasion by 2027, flat over 7 days; TSMC makes 90 of 100 advanced chips.",
    };
    expect(ungroundedNumbers(stock, packet)).toEqual(["90", "100"]);
  });

  it("builds the evidence-only answer in the analyst's order", async () => {
    const packet = gate(await mockPacket("semiconductor chips"), NOW).packet;
    const answer = fallbackFromPacket(packet);
    expect(answer.stocks).toHaveLength(5);
    expect(answer.stocks.map((s) => s.symbol)).toEqual(
      packet.tickerSignals.slice(0, 5).map((t) => t.symbol),
    );
    expect(check(answer, packet).errors).toEqual([]);
  });
});

describe("odds helpers", () => {
  it("formats odds the way reasons quote them", () => {
    expect(formatOdds(0.075)).toBe("7.5");
    expect(formatOdds(0.72)).toBe("72");
    expect(formatOdds(0.9649)).toBe("96.5");
    expect(formatOdds(0.04)).toBe("4");
  });

  it("accepts Yes or No odds within one point and rejects anything else", () => {
    expect(oddsAreAccurate("gives 7.5% that", [TAIWAN])).toBe(true);
    expect(oddsAreAccurate("an 8 percent chance", [TAIWAN])).toBe(true);
    expect(oddsAreAccurate("92.5% say no", [TAIWAN])).toBe(true);
    expect(oddsAreAccurate("gives 30% that", [TAIWAN])).toBe(false);
    expect(oddsAreAccurate("no numbers here", [])).toBe(true);
    expect(oddsAreAccurate("a 10% chance", [])).toBe(false);
  });
});

describe("eval cases", () => {
  it("has 10 valid packets whose gate outcome is the expected one", () => {
    expect(EVAL_CASES).toHaveLength(10);
    for (const c of EVAL_CASES) {
      const packet = evidencePacketSchema.parse(c.packet(NOW));
      expect(gate(packet, NOW).ok, c.name).toBe(c.expect === "decision");
    }
  });
});
