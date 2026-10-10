// Contract tests for POST /api/stocks (docs/API.md section 1) with Gemini and Polymarket mocked.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { MarketCandidate } from "../polymarket/search";
import type { GenerateJson } from "../sponsors/gemini";
import {
  fallbackSelection,
  findStocks,
  formatOdds,
  oddsAreAccurate,
  responseSchema,
} from "./findStocks";
import { createStocksHandler, type HandlerDeps } from "./handler";
import { SYMBOLS } from "./universe";

const market = (over: Partial<MarketCandidate>): MarketCandidate => ({
  id: "1811266",
  question: "Will China invade Taiwan by June 30, 2027?",
  eventTitle: "Will China invade Taiwan by June 30, 2027?",
  url: "https://polymarket.com/event/will-china-invade-taiwan-by-june-30-2027",
  probability: 0.075,
  change7d: -0.01,
  endDate: "2027-07-01T03:59:00Z",
  volume: 472728,
  yesTokenId: "tok-yes",
  linkedSymbols: [],
  ...over,
});

const TAIWAN = market({});
const CHIPS = market({
  id: "900001",
  question: "Will AI-chip export licensing become law this year?",
  url: "https://polymarket.com/event/ai-chip-export-licensing",
  probability: 0.22,
});

const search = async (query: string) => (/taiwan/i.test(query) ? [TAIWAN] : [CHIPS]);

const PLAN = { queries: ["China Taiwan invasion", "AI chip export"], sectors: ["semis"] };
const GOOD_PICK = {
  summary: "Chip makers are exposed to Taiwan risk and to export rules, so these markets matter.",
  stocks: [
    {
      symbol: "TSM",
      market_id: "1811266",
      reason:
        "Polymarket gives 7.5% that China invades Taiwan by mid-2027, the key risk for TSMC's fabs.",
      link: "An invasion would halt TSMC's fabs.",
    },
    {
      symbol: "NVDA",
      market_id: "900001",
      reason:
        "Polymarket gives 22% that AI-chip export licensing becomes law, which would cap NVIDIA's sales.",
      link: "Export licensing would cap NVIDIA's sales abroad.",
    },
    {
      symbol: "INTC",
      market_id: null,
      reason: "Intel is building domestic foundry capacity that benefits from reshoring.",
      link: "Reshoring favors Intel's domestic fabs.",
    },
  ],
};

/** A Gemini mock: the first call is the query plan, later calls are stock picks. */
function gemini(...picks: unknown[]): GenerateJson {
  let call = 0;
  return vi.fn(async () => {
    const i = call++;
    if (i === 0) return PLAN;
    const pick = picks[Math.min(i - 1, picks.length - 1)];
    if (pick instanceof Error) throw pick;
    return pick;
  });
}

function deps(generate: GenerateJson, over: Partial<HandlerDeps> = {}): HandlerDeps {
  return {
    generate,
    search,
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    ...over,
  };
}

function post(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://api.test/api/stocks", {
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

describe("POST /api/stocks", () => {
  it("returns the contract shape with reasons that cite real candidate markets", async () => {
    const { POST } = createStocksHandler(deps(gemini(GOOD_PICK)));
    const res = await POST(post({ idea: "  AI chips and Taiwan risk " }));
    expect(res.status).toBe(200);
    const body = expectContractShape(await res.json());

    expect(body.source).toBe("gemini");
    expect(body.stocks.map((s) => s.symbol)).toEqual(["TSM", "NVDA", "INTC"]);
    expect(body.stocks[0]).toMatchObject({ name: "Taiwan Semiconductor", marketId: "1811266" });
    expect(body.stocks[0].reason).toContain("7.5%");
    expect(body.stocks[2].marketId).toBeNull();
    // Summary carries the key odds, appended by the server from live prices.
    expect(body.summary).toContain('"Will China invade Taiwan by June 30, 2027?" 7.5%');
    expect(body.markets.map((m) => m.id)).toEqual(["1811266", "900001"]);
    expect(body.markets[0]).toMatchObject({ outcome: "Yes", probability: 0.075 });
  });

  it("drops stocks that cite a market Gemini made up, then retries once", async () => {
    const invented = {
      ...GOOD_PICK,
      stocks: GOOD_PICK.stocks.map((s, i) => (i === 0 ? { ...s, market_id: "424242" } : s)),
    };
    const generate = gemini(invented, GOOD_PICK);
    const { POST } = createStocksHandler(deps(generate));
    const body = expectContractShape(await (await POST(post({ idea: "chips" }))).json());
    expect(generate).toHaveBeenCalledTimes(3); // plan + rejected pick + retry
    expect(body.source).toBe("gemini");
    expect(body.markets.every((m) => ["1811266", "900001"].includes(m.id))).toBe(true);
  });

  it("rewrites a reason whose quoted odds do not match the cited market", async () => {
    const wrong = {
      ...GOOD_PICK,
      stocks: GOOD_PICK.stocks.map((s, i) =>
        i === 0 ? { ...s, reason: "Polymarket gives 60% that China invades Taiwan." } : s,
      ),
    };
    const { POST } = createStocksHandler(deps(gemini(wrong)));
    const body = expectContractShape(await (await POST(post({ idea: "taiwan chips" }))).json());
    expect(body.stocks[0].reason).not.toContain("60%");
    expect(body.stocks[0].reason).toBe(
      'Polymarket gives 7.5% to "Will China invade Taiwan by June 30, 2027?": An invasion would halt TSMC\'s fabs.',
    );
  });

  it("falls back to keyword matches in the same shape when Gemini fails", async () => {
    const generate: GenerateJson = vi.fn(async () => {
      throw new Error("503 overloaded");
    });
    const linked = async () => [market({ linkedSymbols: ["TSM", "NVDA"] })];
    const { POST } = createStocksHandler(deps(generate, { search: linked }));
    const res = await POST(post({ idea: "I believe in semiconductor chips" }));
    expect(res.status).toBe(200);
    const body = expectContractShape(await res.json());
    expect(body.source).toBe("fallback");
    expect(body.summary).toMatch(/keyword match/i);
    expect(body.stocks[0].reason).toContain("Polymarket gives 7.5%");
  });

  it("falls back when Gemini keeps returning invalid output", async () => {
    const { POST } = createStocksHandler(deps(gemini({ nonsense: true })));
    const body = expectContractShape(
      await (await POST(post({ idea: "bitcoin and crypto" }))).json(),
    );
    expect(body.source).toBe("fallback");
    expect(body.stocks.map((s) => s.symbol)).toContain("COIN");
  });

  it("answers 502 instead of inventing a basket when nothing matches and Gemini is down", async () => {
    const generate: GenerateJson = async () => {
      throw new Error("down");
    };
    const { POST } = createStocksHandler(deps(generate, { search: async () => [] }));
    const res = await POST(post({ idea: "zzzz qqqq" }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({
      error: { code: "no_match", message: expect.any(String) },
    });
  });

  it.each([
    ["missing idea", {}],
    ["empty idea", { idea: "   " }],
    ["non-string idea", { idea: 42 }],
    ["too long", { idea: "x".repeat(501) }],
    ["not JSON", "{oops"],
  ])("rejects an invalid request (%s) with 400 and the error shape", async (_name, payload) => {
    const generate = gemini(GOOD_PICK);
    const { POST } = createStocksHandler(deps(generate));
    const res = await POST(post(payload));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({ error: { code: "invalid_request", message: expect.any(String) } });
    expect(generate).not.toHaveBeenCalled();
  });

  it("returns 429 with Retry-After when the rate limit is hit, without calling Gemini", async () => {
    const generate = gemini(GOOD_PICK);
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
    const { POST, OPTIONS } = createStocksHandler(deps(gemini(GOOD_PICK)));
    const pages = "https://becomingwise.github.io";

    const pre = OPTIONS(
      new Request("https://api.test/api/stocks", { method: "OPTIONS", headers: { Origin: pages } }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(pages);
    expect(pre.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(pre.headers.get("Access-Control-Allow-Headers")).toContain("Content-Type");

    const ok = await POST(post({ idea: "cors check idea" }, { Origin: "http://127.0.0.1:8000" }));
    expect(ok.headers.get("Access-Control-Allow-Origin")).toBe("http://127.0.0.1:8000");

    const bad = await POST(post({ idea: "" }, { Origin: pages }));
    expect(bad.headers.get("Access-Control-Allow-Origin")).toBe(pages);

    const other = await POST(
      post({ idea: "cors check idea 2" }, { Origin: "https://evil.example" }),
    );
    expect(other.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });
});

describe("findStocks with the team's real controller", () => {
  const controllerPath = path.resolve(process.cwd(), "..", "js", "controller.js");

  it.skipIf(!existsSync(controllerPath))(
    "passes validateStocks and opens the dashboard",
    async () => {
      const { createController } = await import(
        /* @vite-ignore */ pathToFileURL(controllerPath).href
      );
      const controller = createController({
        findStocks: ({ idea }: { idea: string }) =>
          findStocks({ idea }, { generate: gemini(GOOD_PICK), search }),
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

describe("fallbackSelection", () => {
  it("puts market-backed stocks first and gives the rest a plain keyword reason", () => {
    const out = fallbackSelection(
      "semiconductor chips",
      [market({ linkedSymbols: ["AMD", "MU"] })],
      "2026-10-10T00:00:00.000Z",
    );
    expect(out.stocks.map((s) => s.symbol)).toEqual(["AMD", "MU", "NVDA", "TSM", "AVGO"]);
    expect(out.stocks[0].marketId).toBe("1811266");
    expect(out.stocks[2]).toMatchObject({ marketId: null });
    expect(out.stocks[2].reason).not.toMatch(/polymarket|%/i);
    expect(out.markets).toHaveLength(1);
  });
});

describe("fallbackSelection across themes", () => {
  it("covers every matched sector and cites the market each stock is most sensitive to", () => {
    const fed = market({
      id: "fed",
      question: "Will no Fed rate cuts happen in 2026?",
      probability: 0.956,
    });
    const out = fallbackSelection(
      "Bitcoin goes up and the Fed cuts rates",
      [
        market({ linkedSymbols: ["TLT"], linkedBetas: { TLT: 0.3 } }),
        { ...fed, linkedSymbols: ["TLT", "IBIT"], linkedBetas: { TLT: -0.6, IBIT: -0.4 } },
      ],
      "2026-10-10T00:00:00.000Z",
    );
    const symbols = out.stocks.map((s) => s.symbol);
    expect(symbols).toContain("TLT");
    expect(symbols).toContain("IBIT");
    expect(symbols.some((s) => ["COIN", "MSTR"].includes(s))).toBe(true);
    // TLT is linked to both markets; the Fed market has the larger beta.
    expect(out.stocks.find((s) => s.symbol === "TLT")!.marketId).toBe("fed");
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
    expect(oddsAreAccurate("an 8% chance", [TAIWAN])).toBe(true);
    expect(oddsAreAccurate("92.5% say no", [TAIWAN])).toBe(true);
    expect(oddsAreAccurate("gives 30% that", [TAIWAN])).toBe(false);
    expect(oddsAreAccurate("no numbers here", [])).toBe(true);
    expect(oddsAreAccurate("a 10% chance", [])).toBe(false);
  });
});
