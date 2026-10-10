// Saved baskets: POST /api/baskets, GET /api/baskets/{id}, GET /b/{id} (docs/API.md section 3).
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { createBasketHandlers, type BasketDeps } from "./handler";
import type { Basket } from "./schema";
import { BASKET_ID_PATTERN, newBasketId, type BasketStore, type StoredBasket } from "./store";

// Real response shapes of /api/stocks and /api/weights, extras included.
const STOCKS = {
  summary:
    'Chip makers and Taiwan risk. Key Polymarket odds: "Will China invade Taiwan by December 31, 2027?" 11%.',
  stocks: [
    {
      symbol: "TSM",
      name: "Taiwan Semiconductor",
      reason: "Polymarket gives 11% that …",
      marketId: "1633611",
    },
    { symbol: "NVDA", name: "NVIDIA", reason: "Polymarket gives 21% that …", marketId: "1426260" },
    { symbol: "INTC", name: "Intel", reason: "Domestic foundry capacity.", marketId: null },
  ],
  source: "gemini",
  markets: [
    {
      id: "1633611",
      title: "Will China invade Taiwan by December 31, 2027?",
      url: "https://polymarket.com/event/will-china-invade-taiwan-by-december-31-2027",
      outcome: "Yes",
      probability: 0.105,
      observedAt: "2026-10-10T00:34:53.768Z",
    },
    {
      id: "1426260",
      title: "Will AI-chip export licensing become law this year?",
      url: "https://polymarket.com/event/which-bills-will-become-law-in-2026",
      outcome: "Yes",
      probability: 0.21,
      observedAt: "2026-10-10T00:34:53.768Z",
    },
  ],
};

const WEIGHTS = {
  status: "adjusted",
  holdings: [
    { symbol: "TSM", weightPct: 32.75 },
    { symbol: "NVDA", weightPct: 37.06 },
    { symbol: "INTC", weightPct: 30.19 },
  ],
  explanation: "Tilted by Polymarket odds moves over the past week: NVDA 33.3% → 37.1% …",
  evidence: [
    {
      title: "Will AI-chip export licensing become law this year?",
      url: "https://polymarket.com/event/which-bills-will-become-law-in-2026",
      outcome: "Yes",
      probability: 0.225,
      observedAt: "2026-10-10T00:35:01.000Z",
      change7d: -0.125,
      symbols: ["INTC", "NVDA"],
    },
    {
      title: "Bab el-Mandeb Strait effectively closed by December 31?",
      url: "https://polymarket.com/event/bab-el-mandeb",
      outcome: "Yes",
      probability: 0.15,
      observedAt: "2026-10-10T00:35:01.000Z",
      change7d: null,
      symbols: ["TSM"],
    },
  ],
};

function memoryStore(): BasketStore & { rows: Map<string, StoredBasket> } {
  const rows = new Map<string, StoredBasket>();
  return {
    rows,
    async insert(basket) {
      const id = newBasketId();
      const createdAt = "2026-10-10T01:00:00.000Z";
      rows.set(id, { id, createdAt, ...basket });
      return { id, createdAt };
    },
    async get(id) {
      return rows.get(id) ?? null;
    },
  };
}

function setup(over: Partial<BasketDeps> = {}) {
  const store = memoryStore();
  const handlers = createBasketHandlers({
    store,
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    marketIds: async () => (e) =>
      e.title === "Will AI-chip export licensing become law this year?" ? "1426260" : null,
    ...over,
  });
  const save = (body: unknown, headers: Record<string, string> = {}) =>
    handlers.save(
      new Request("https://prophetf.vercel.app/api/baskets", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
    );
  const get = (id: string, headers: Record<string, string> = {}) =>
    handlers.get(new Request(`https://prophetf.vercel.app/api/baskets/${id}`, { headers }), id);
  return { ...handlers, store, save, get };
}

describe("POST /api/baskets", () => {
  it("accepts the /api/stocks and /api/weights responses as they are", async () => {
    const api = setup();
    const res = await api.save({
      idea: " AI chips and Taiwan risk ",
      stocks: STOCKS,
      weights: WEIGHTS,
    });
    expect(res.status).toBe(201);
    const basket = (await res.json()) as Basket;

    expect(basket.id).toMatch(BASKET_ID_PATTERN);
    expect(basket.url).toBe(`https://prophetf.vercel.app/b/${basket.id}`);
    expect(res.headers.get("Location")).toBe(`/api/baskets/${basket.id}`);
    expect(basket.idea).toBe("AI chips and Taiwan risk");
    expect(basket.summary).toBe(STOCKS.summary);
    expect(basket.source).toBe("gemini");
    expect(basket.stocks).toEqual([
      { ...STOCKS.stocks[0], weightPct: 32.75 },
      { ...STOCKS.stocks[1], weightPct: 37.06 },
      { ...STOCKS.stocks[2], weightPct: 30.19 },
    ]);
    expect(basket.weights).toEqual(WEIGHTS);
  });

  it("stores the cited markets with their odds at creation, merged across both steps", async () => {
    const basket = (await (
      await setup().save({ idea: "chips", stocks: STOCKS, weights: WEIGHTS })
    ).json()) as Basket;
    expect(basket.markets).toEqual([
      {
        id: "1633611",
        title: "Will China invade Taiwan by December 31, 2027?",
        url: STOCKS.markets[0].url,
        outcome: "Yes",
        probability: 0.105,
        observedAt: "2026-10-10T00:34:53.768Z",
        change7d: null,
        citedBy: ["stocks"],
      },
      {
        id: "1426260",
        title: "Will AI-chip export licensing become law this year?",
        url: STOCKS.markets[1].url,
        outcome: "Yes",
        probability: 0.21,
        observedAt: "2026-10-10T00:34:53.768Z",
        change7d: -0.125,
        citedBy: ["stocks", "weights"],
      },
      {
        id: null,
        title: "Bab el-Mandeb Strait effectively closed by December 31?",
        url: "https://polymarket.com/event/bab-el-mandeb",
        outcome: "Yes",
        probability: 0.15,
        observedAt: "2026-10-10T00:35:01.000Z",
        change7d: null,
        citedBy: ["weights"],
      },
    ]);
  });

  it("saves equal weights when the weights step is missing", async () => {
    const basket = (await (await setup().save({ idea: "chips", stocks: STOCKS })).json()) as Basket;
    expect(basket.weights.status).toBe("unavailable");
    expect(basket.stocks.map((s) => s.weightPct)).toEqual([33.33, 33.33, 33.34]);
    expect(basket.weights.evidence).toEqual([]);
  });

  it("calls onSaved with the basket and still succeeds when it throws", async () => {
    const seen: string[] = [];
    const api = setup({
      onSaved: async (basket) => {
        seen.push(basket.id);
        throw new Error("tracking down");
      },
    });
    const res = await api.save({ idea: "chips", stocks: STOCKS, weights: WEIGHTS });
    expect(res.status).toBe(201);
    expect(seen).toEqual([(await res.json()).id]);
  });

  it.each([
    ["not JSON", "{oops", /JSON/],
    ["missing idea", { stocks: STOCKS, weights: WEIGHTS }, /idea/],
    ["missing stocks", { idea: "x", weights: WEIGHTS }, /stocks/],
    ["empty stock list", { idea: "x", stocks: { ...STOCKS, stocks: [] } }, /stocks\.stocks/],
    [
      "holdings for other symbols",
      {
        idea: "x",
        stocks: STOCKS,
        weights: { ...WEIGHTS, holdings: [{ symbol: "AMD", weightPct: 100 }] },
      },
      /exactly the symbols/,
    ],
    [
      "weights not totalling 100",
      {
        idea: "x",
        stocks: STOCKS,
        weights: { ...WEIGHTS, holdings: WEIGHTS.holdings.map((h) => ({ ...h, weightPct: 10 })) },
      },
      /total 100/,
    ],
    [
      "duplicate symbols",
      { idea: "x", stocks: { ...STOCKS, stocks: [STOCKS.stocks[0], STOCKS.stocks[0]] } },
      /duplicate/,
    ],
    [
      "a probability out of range",
      { idea: "x", stocks: { ...STOCKS, markets: [{ ...STOCKS.markets[0], probability: 7 }] } },
      /probability/,
    ],
    [
      "a non-http evidence URL",
      {
        idea: "x",
        stocks: { ...STOCKS, markets: [{ ...STOCKS.markets[0], url: "javascript:alert(1)" }] },
      },
      /url/,
    ],
  ])("rejects %s with 400", async (_name, body, message) => {
    const api = setup();
    const res = await api.save(body);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_request");
    expect(json.error.message).toMatch(message);
    expect(api.store.rows.size).toBe(0);
  });

  it("rejects oversized bodies and rate-limited callers without saving", async () => {
    const big = setup();
    expect((await big.save({ idea: "x".repeat(70_000), stocks: STOCKS })).status).toBe(413);

    const limited = setup({ rateLimit: async () => ({ allowed: false, retryAfterSeconds: 30 }) });
    const res = await limited.save({ idea: "x", stocks: STOCKS });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(limited.store.rows.size).toBe(0);
  });

  it("answers 503 when storage fails", async () => {
    const api = setup({
      store: {
        insert: async () => {
          throw new Error("db down");
        },
        get: async () => {
          throw new Error("db down");
        },
      },
    });
    expect((await api.save({ idea: "x", stocks: STOCKS })).status).toBe(503);
    expect((await api.get("abcdefgh")).status).toBe(503);
  });
});

describe("GET /api/baskets/{id}", () => {
  it("returns exactly what was saved, with CORS for the frontend", async () => {
    const api = setup();
    const saved = await (
      await api.save({ idea: "chips", stocks: STOCKS, weights: WEIGHTS })
    ).json();
    const res = await api.get(saved.id, { Origin: "https://becomingwise.github.io" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(saved);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://becomingwise.github.io");
    expect(res.headers.get("Content-Type")).toContain("charset=utf-8");
  });

  it("answers 404 for unknown and malformed ids", async () => {
    const api = setup();
    for (const id of ["abcdefgh", "nope", "../../etc", "ABCDEFGH", ""]) {
      const res = await api.get(id);
      expect(res.status).toBe(404);
      expect((await res.json()).error.code).toBe("not_found");
    }
  });

  it("allows GET in the CORS preflight", () => {
    const res = setup().options(
      new Request("https://prophetf.vercel.app/api/baskets/abcdefgh", {
        method: "OPTIONS",
        headers: { Origin: "http://localhost:8000" },
      }),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
  });
});

describe("js/baskets-adapter.js", () => {
  const adapterPath = path.resolve(process.cwd(), "..", "js", "baskets-adapter.js");

  it.skipIf(!existsSync(adapterPath))(
    "saves a controller snapshot and loads it back through the handlers",
    async () => {
      const { createBaskets, basketFromState } = await import(
        /* @vite-ignore */ pathToFileURL(adapterPath).href
      );
      const api = setup();
      const fetchFn = async (url: string, init: RequestInit = {}) => {
        const request = new Request(url, init);
        return request.method === "POST"
          ? api.save(await request.json())
          : api.get(new URL(url).pathname.split("/").pop()!);
      };
      const { saveBasket, getBasket } = createBaskets({ fetch: fetchFn });

      // What controller.getState() holds once the flow is "ready": extras already dropped.
      const state = {
        idea: "AI chips and Taiwan risk",
        summary: STOCKS.summary,
        stocks: STOCKS.stocks.map(({ symbol, name, reason }) => ({ symbol, name, reason })),
        holdings: WEIGHTS.holdings,
        adjustment: {
          status: "adjusted",
          explanation: WEIGHTS.explanation,
          evidence: WEIGHTS.evidence,
        },
      };
      const saved = await saveBasket(basketFromState(state));
      expect(saved.id).toMatch(BASKET_ID_PATTERN);
      expect(saved.stocks.map((s: { weightPct: number }) => s.weightPct)).toEqual([
        32.75, 37.06, 30.19,
      ]);
      expect(await getBasket(saved.id)).toEqual(saved);
      await expect(getBasket("zzzzzzzz")).rejects.toThrow(/No basket/);

      const unavailable = basketFromState({
        ...state,
        adjustment: {
          status: "unavailable",
          explanation: "No adjustment was applied.",
          evidence: [],
        },
      });
      expect((await saveBasket(unavailable)).weights.status).toBe("unavailable");
    },
  );
});
