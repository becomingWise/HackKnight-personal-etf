// POST /api/stocks on top of the stock agent: the HTTP contract (docs/API.md section 1) and the
// copies of /agent this app runs. Gemini is mocked through the agent's callModel.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentError, createFindStocks } from "../agent-core/agent/gemini.js";
import { createMemoryStore } from "../agent-core/agent/memory.js";
import { memoryApiCache } from "../cache/apiCache";
import { memoryModelBudget } from "../gemini/budget";
import { memorySavings } from "../savings/store";
import type { Signal } from "../weights/engine";
import { agentBudget, agentCache } from "./adapters";
import { createAgentStocksHandler, type FindStocks } from "./handler";

const SELECTION = {
  summary: "Your AI chips basket",
  stocks: [
    { symbol: "NVDA", name: "NVIDIA" },
    { symbol: "TSM", name: "Taiwan Semiconductor" },
    { symbol: "AMD", name: "Advanced Micro Devices" },
  ],
};
const allow = async () => ({ allowed: true, retryAfterSeconds: 0 });
const post = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://prophetf.vercel.app/api/stocks", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const answer = (symbols: string[]) => ({
  candidates: [
    {
      content: {
        role: "model",
        parts: [{ text: JSON.stringify({ summary: "Your AI chips basket", symbols }) }],
      },
    },
  ],
});

describe("POST /api/stocks (stock agent)", () => {
  it("returns exactly { summary, stocks: [{ symbol, name }] }", async () => {
    const findStocks = vi.fn<FindStocks>(async () => SELECTION);
    const { POST } = createAgentStocksHandler({ findStocks, rateLimit: allow });
    const response = await POST(post({ idea: "AI chips" }, { "X-Session-Id": "tab-1" }));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual(SELECTION);
    expect(Object.keys(body).sort()).toEqual(["stocks", "summary"]);
    expect(findStocks.mock.calls[0][0]).toEqual({ idea: "AI chips" });
    expect(findStocks.mock.calls[0][1]).toMatchObject({ sessionId: "tab-1", basket: false });
  });

  it("runs the real agent end to end with Gemini mocked", async () => {
    const callModel = vi.fn(async () => answer(["NVDA", "TSM", "AMD"]));
    const findStocks = createFindStocks({
      callModel,
      memory: createMemoryStore(),
      cache: agentCache(memoryApiCache()),
      budget: agentBudget(memoryModelBudget()),
      sessionId: null,
    }) as FindStocks;
    const { POST } = createAgentStocksHandler({ findStocks, rateLimit: allow });

    const first = await POST(post({ idea: "AI chips and Taiwan risk", basket: true }));
    const body = await first.json();
    expect(body.stocks).toEqual(SELECTION.stocks);
    expect(body.basket.holdings.map((h: { weightPct: number }) => h.weightPct)).toEqual([
      33.33, 33.33, 33.34,
    ]);
    // The same idea again comes from the shared cache: no second Gemini call.
    expect(await (await POST(post({ idea: "ai chips and taiwan risk" }))).json()).toEqual(
      SELECTION,
    );
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("answers with an error, never with substitute companies", async () => {
    const failing = (err: unknown) =>
      createAgentStocksHandler({
        findStocks: async () => {
          throw err;
        },
        rateLimit: allow,
      }).POST(post({ idea: "AI chips" }));

    const unavailable = await failing(
      new AgentError("gemini_unavailable", "No Gemini model is available right now.", 503),
    );
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({
      error: { code: "gemini_unavailable", message: "No Gemini model is available right now." },
    });
    expect(
      (await failing(new AgentError("invalid_idea", "idea must be a non-empty string.", 400)))
        .status,
    ).toBe(400);
    const unknown = await failing(new Error("boom"));
    expect(unknown.status).toBe(502);
    expect((await unknown.json()).error.code).toBe("upstream_error");
  });

  it("rejects a body that is not JSON and applies the per-IP limit", async () => {
    const findStocks = vi.fn<FindStocks>(async () => SELECTION);
    const open = createAgentStocksHandler({ findStocks, rateLimit: allow });
    expect((await open.POST(post("hello"))).status).toBe(400);
    const closed = createAgentStocksHandler({
      findStocks,
      rateLimit: async () => ({ allowed: false, retryAfterSeconds: 12 }),
    });
    const limited = await closed.POST(post({ idea: "AI chips" }));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("12");
    expect(findStocks).not.toHaveBeenCalled();
  });

  it("lets the website send the session header across origins", async () => {
    const { OPTIONS } = createAgentStocksHandler({
      findStocks: async () => SELECTION,
      rateLimit: allow,
    });
    const response = OPTIONS(
      new Request("https://prophetf.vercel.app/api/stocks", {
        method: "OPTIONS",
        headers: { Origin: "https://becomingwise.github.io" },
      }),
    );
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://becomingwise.github.io",
    );
    expect(response.headers.get("Access-Control-Allow-Headers")).toContain("X-Session-Id");
  });

  it("passes the live Polymarket signals on, and answers without them when they fail", async () => {
    const signals: Signal[] = [
      {
        id: "taiwan",
        label: "China invades Taiwan",
        status: "live",
        price: 0.08,
        question: "Will China invade Taiwan by end of 2026?",
        changes: { "1w": -0.02 },
        betas: { TSM: -1.0, NVDA: -0.5 },
      },
    ];
    const findStocks = vi.fn<FindStocks>(async () => SELECTION);
    const live = createAgentStocksHandler({
      findStocks,
      signals: async () => signals,
      rateLimit: allow,
    });
    expect((await live.POST(post({ idea: "AI chips" }))).status).toBe(200);
    expect(findStocks.mock.calls[0][1].signals).toBe(signals);

    const failing = createAgentStocksHandler({
      findStocks,
      signals: async () => {
        throw new Error("gamma down");
      },
      rateLimit: allow,
    });
    const response = await failing.POST(post({ idea: "AI chips" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(SELECTION);
    expect(findStocks.mock.calls[1][1].signals).toBeUndefined();
  });

  it("adds the odds line from live data and keeps { summary, stocks } only", async () => {
    const callModel = vi.fn(async () => ({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                text: JSON.stringify({
                  summary: "Your AI chips basket",
                  symbols: ["NVDA", "TSM", "AMD"],
                  signals: ["taiwan", "made_up"],
                }),
              },
            ],
          },
        },
      ],
    }));
    const findStocks = createFindStocks({
      callModel,
      memory: createMemoryStore(),
      cache: agentCache(memoryApiCache()),
      budget: agentBudget(memoryModelBudget()),
      sessionId: null,
    }) as FindStocks;
    const { POST } = createAgentStocksHandler({
      findStocks,
      signals: async () => [
        {
          id: "taiwan",
          label: "China invades Taiwan",
          status: "live",
          price: 0.08,
          changes: { "1w": -0.02 },
          betas: { TSM: -1.0 },
        },
      ],
      rateLimit: allow,
    });
    const body = await (await POST(post({ idea: "AI chips and Taiwan risk" }))).json();
    expect(body).toEqual({
      summary:
        "Your AI chips basket Live Polymarket odds: China invades Taiwan 8% (▼2 pts this week).",
      stocks: SELECTION.stocks,
    });
    expect(callModel).toHaveBeenCalledTimes(1);
  });

  it("reuses an answer until its odds move 3 points, and says so in the headers", async () => {
    let now = Date.UTC(2026, 9, 10, 12);
    let taiwan = 0.08;
    const callModel = vi.fn(async () => ({
      candidates: [
        {
          content: {
            role: "model",
            parts: [
              {
                text: JSON.stringify({
                  summary: "Your AI chips basket",
                  symbols: ["NVDA", "TSM", "AMD"],
                  signals: ["taiwan"],
                }),
              },
            ],
          },
        },
      ],
    }));
    const findStocks = createFindStocks({
      callModel,
      memory: createMemoryStore(),
      cache: agentCache(memoryApiCache(() => now)),
      budget: agentBudget(memoryModelBudget()),
      sessionId: null,
      now: () => now,
    }) as FindStocks;
    const store = memorySavings((day) =>
      day === "d:2026-10-10" ? callModel.mock.calls.length : 0,
    );
    const { POST } = createAgentStocksHandler({
      findStocks,
      signals: async () => [
        {
          id: "taiwan",
          label: "China invades Taiwan",
          status: "live",
          price: taiwan,
          changes: { "1w": -0.02 },
          betas: { TSM: -1.0 },
        },
      ],
      count: (endpoint, reused) => store.record(endpoint, reused, new Date(now)),
      rateLimit: allow,
    });
    const ask = async (session: string) => {
      const response = await POST(
        post({ idea: "AI chips and Taiwan risk" }, { "X-Session-Id": session }),
      );
      const body = await response.json();
      expect(Object.keys(body).sort()).toEqual(["stocks", "summary"]);
      return [response.headers.get("X-Cache"), response.headers.get("X-Odds-Moved"), body.summary];
    };

    expect(await ask("tab-1")).toEqual([
      "MISS",
      null,
      "Your AI chips basket Live Polymarket odds: China invades Taiwan 8% (▼2 pts this week).",
    ]);
    // Another visitor, three hours later, odds 2 points higher: reused, with today's odds.
    now += 3 * 3600_000;
    taiwan = 0.1;
    expect(await ask("tab-2")).toEqual([
      "HIT",
      "2",
      "Your AI chips basket Live Polymarket odds: China invades Taiwan 10% (▼2 pts this week).",
    ]);
    expect(callModel).toHaveBeenCalledTimes(1);
    // 3 points away from the answer: Gemini decides again.
    taiwan = 0.11;
    expect((await ask("tab-3")).slice(0, 2)).toEqual(["MISS", "3"]);
    expect(callModel).toHaveBeenCalledTimes(2);
    expect((await ask("tab-1")).slice(0, 2)).toEqual(["HIT", "0"]);

    expect(await store.read(new Date(now))).toEqual({
      day: "2026-10-10",
      answers: 4,
      newAnswers: 2,
      reused: 2,
      reusedPct: 50,
      geminiCalls: 2,
    });
  });

  it("does not count a failed request, and a counting problem never fails an answer", async () => {
    const count = vi.fn(async () => {
      throw new Error("db down");
    });
    const ok = createAgentStocksHandler({
      findStocks: async () => SELECTION,
      count,
      rateLimit: allow,
    });
    expect((await ok.POST(post({ idea: "AI chips" }))).status).toBe(200);
    expect(count).toHaveBeenCalledWith("stocks", false);
    const failing = createAgentStocksHandler({
      findStocks: async () => {
        throw new AgentError("gemini_unavailable", "No Gemini model is available right now.", 503);
      },
      count,
      rateLimit: allow,
    });
    await failing.POST(post({ idea: "AI chips" }));
    expect(count).toHaveBeenCalledTimes(1);
  });

  it("counts the agent's calls against the model budgets and keeps search blocks apart", async () => {
    const budget = agentBudget(memoryModelBudget());
    expect(await budget.reserve("gemini-3.5-flash-lite", "agent")).toBeNull();
    expect(await budget.reserve("some-unknown-model", "agent")).toBe("unknown model");
    await budget.block("gemini-3.5-flash-lite", "search", Date.now() + 60_000, "429: rate limited");
    // A model without Google Search quota stays usable for the agent's own turns.
    expect(await budget.reserve("gemini-3.5-flash-lite", "agent")).toBeNull();
  });
});

describe("the copies of /agent", () => {
  const root = path.join(process.cwd(), "..");
  const files = [
    "agent/gemini.js",
    "agent/tools.js",
    "agent/retrieval.js",
    "agent/signals.js",
    "agent/memory.js",
    "agent/basket.js",
    "agent/project-notes.json",
    "js/controller.js",
  ];
  const text = (file: string) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");

  // On Vercel only /web exists; the comparison runs wherever the repository root is present.
  it.skipIf(!existsSync(path.join(root, "agent", "gemini.js")))(
    "are identical to the originals (run `pnpm sync:agent` after editing /agent)",
    () => {
      for (const file of files) {
        expect(text(path.join("src", "lib", "agent-core", file)), file).toBe(
          text(path.join(root, file)),
        );
      }
    },
  );
});
