// Response caching for /api/stocks and /api/weights, and the demo warm-up job.
import { describe, expect, it, vi } from "vitest";
import { DEMO_IDEAS, stalestIdea, warmIdea, type WarmDeps } from "../demo/warm";
import type { MarketCandidate } from "../polymarket/search";
import type { GenerateJson } from "../sponsors/gemini";
import { createStocksHandler, type HandlerDeps } from "../stocks/handler";
import type { Signal } from "../weights/engine";
import { createWeightsHandler } from "../weights/handler";
import {
  CACHE_TTL_SECONDS,
  memoryApiCache,
  normalizeIdea,
  stocksCacheKey,
  weightsCacheKey,
} from "./apiCache";

const MARKET: MarketCandidate = {
  id: "1633611",
  question: "Will China invade Taiwan by December 31, 2027?",
  eventTitle: "Taiwan",
  url: "https://polymarket.com/event/taiwan",
  probability: 0.105,
  change7d: -0.01,
  endDate: null,
  volume: 1000,
  yesTokenId: "tok",
  linkedSymbols: [],
};

const PICK = {
  summary: "Chip makers are exposed to Taiwan risk, so this market matters.",
  stocks: ["TSM", "NVDA", "AMD"].map((symbol) => ({
    symbol,
    market_id: "1633611",
    reason: "Polymarket gives 10.5% that China invades Taiwan, a key risk for this company.",
    link: "An invasion would disrupt chip supply.",
  })),
};

/** Gemini mock: plan first, then the pick (or an error when `down` is set). */
function gemini(state: { down: boolean } = { down: false }): GenerateJson {
  return vi.fn(async ({ prompt }) => {
    if (state.down) throw new Error("429 quota");
    return prompt.startsWith("Sector ids") ? { queries: ["taiwan"], sectors: ["semis"] } : PICK;
  });
}

const allow = async () => ({ allowed: true, retryAfterSeconds: 0 });

function stocksApi(over: Partial<HandlerDeps> = {}) {
  let clock = Date.parse("2026-10-10T12:00:00Z");
  const cache = memoryApiCache(() => clock);
  const generate = gemini();
  const { POST } = createStocksHandler({
    generate,
    search: async () => [MARKET],
    rateLimit: allow,
    cache,
    ...over,
  });
  const post = (idea: string) =>
    POST(
      new Request("https://api.test/api/stocks", {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:8000" },
        body: JSON.stringify({ idea }),
      }),
    );
  return { post, generate, cache, advance: (seconds: number) => (clock += seconds * 1000) };
}

describe("normalizeIdea", () => {
  it("ignores case, spacing, Unicode form and surrounding punctuation", () => {
    const key = stocksCacheKey("AI chips and Taiwan risk");
    for (const variant of [
      "  ai chips   and taiwan risk ",
      "AI Chips And Taiwan Risk.",
      "“AI chips and Taiwan risk!”",
      "ＡＩ chips and Taiwan risk",
    ]) {
      expect(stocksCacheKey(variant)).toBe(key);
    }
    expect(stocksCacheKey("AI chips and Taiwan risks")).not.toBe(key);
    expect(normalizeIdea(" Fed rate-cuts & housing? ")).toBe("fed rate-cuts & housing");
  });
});

describe("POST /api/stocks caching", () => {
  it("answers a repeated idea from the cache and says so", async () => {
    const api = stocksApi();
    const first = await api.post("AI chips and Taiwan risk");
    const firstBody = await first.json();
    expect(first.headers.get("X-Cache")).toBe("MISS");
    expect(firstBody).toMatchObject({ source: "gemini", cached: false, cachedAt: null });
    expect(api.generate).toHaveBeenCalledTimes(2);

    api.advance(90);
    const second = await api.post("  ai chips and taiwan risk. ");
    const secondBody = await second.json();
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(second.headers.get("X-Cache-Age")).toMatch(/^[0-9]+$/);
    expect(second.headers.get("Access-Control-Expose-Headers")).toContain("X-Cache");
    expect(secondBody).toMatchObject({ cached: true, cachedAt: "2026-10-10T12:00:00.000Z" });
    expect(secondBody.stocks).toEqual(firstBody.stocks);
    expect(secondBody.summary).toBe(firstBody.summary);
    expect(api.generate).toHaveBeenCalledTimes(2); // no new Gemini calls
  });

  it("expires after 15 minutes", async () => {
    const api = stocksApi();
    await api.post("chips");
    api.advance(CACHE_TTL_SECONDS - 1);
    expect((await api.post("chips")).headers.get("X-Cache")).toBe("HIT");
    api.advance(2);
    expect((await api.post("chips")).headers.get("X-Cache")).toBe("MISS");
    expect(api.generate).toHaveBeenCalledTimes(4);
  });

  it("never caches a keyword fallback", async () => {
    const state = { down: true };
    const api = stocksApi({ generate: gemini(state) });
    const first = await (await api.post("semiconductor chips")).json();
    expect(first).toMatchObject({ source: "fallback", cached: false });
    state.down = false;
    const second = await (await api.post("semiconductor chips")).json();
    expect(second).toMatchObject({ source: "gemini", cached: false });
  });

  it("counts only uncached requests against the global Gemini budget", async () => {
    const buckets: string[] = [];
    const api = stocksApi({
      rateLimit: async (limits) => {
        buckets.push(...limits.map((l) => l.bucket.split(":").slice(0, 2).join(":")));
        return { allowed: true, retryAfterSeconds: 0 };
      },
    });
    await api.post("chips");
    await api.post("chips");
    expect(buckets.filter((b) => b === "findstocks:uncached")).toHaveLength(1);
    expect(buckets.filter((b) => b === "findstocks:ip")).toHaveLength(2);
  });
});

const SIGNALS: Signal[] = [
  {
    id: "taiwan",
    label: "Taiwan",
    status: "live",
    price: 0.3,
    question: "Will China invade Taiwan by December 31, 2027?",
    url: "https://polymarket.com/event/taiwan",
    changes: { "1w": 0.1 },
    betas: { TSM: -1, INTC: 0.5 },
  },
];

describe("POST /api/weights caching", () => {
  function weightsApi() {
    let clock = Date.parse("2026-10-10T12:00:00Z");
    const signals = vi.fn(async () => SIGNALS);
    const { POST } = createWeightsHandler({
      signals,
      rateLimit: allow,
      cache: memoryApiCache(() => clock),
    });
    const post = (holdings: unknown, idea = "chips") =>
      POST(
        new Request("https://api.test/api/weights", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idea, holdings }),
        }),
      );
    return { post, signals, advance: (seconds: number) => (clock += seconds * 1000) };
  }
  const HOLDINGS = [
    { symbol: "TSM", weightPct: 50 },
    { symbol: "INTC", weightPct: 50 },
  ];

  it("answers an identical request from the cache, whatever the idea text", async () => {
    const api = weightsApi();
    const first = await api.post(HOLDINGS);
    const firstBody = await first.json();
    expect(first.headers.get("X-Cache")).toBe("MISS");
    expect(firstBody).toMatchObject({ status: "adjusted", cached: false, cachedAt: null });

    const second = await api.post(HOLDINGS, "a different idea");
    const secondBody = await second.json();
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(secondBody).toMatchObject({ cached: true, cachedAt: "2026-10-10T12:00:00.000Z" });
    expect(secondBody.holdings).toEqual(firstBody.holdings);
    expect(secondBody.evidence).toEqual(firstBody.evidence);
    expect(api.signals).toHaveBeenCalledTimes(1);
  });

  it("treats different weights, order or symbol casing as different requests, and expires", async () => {
    const api = weightsApi();
    await api.post(HOLDINGS);
    for (const other of [
      [HOLDINGS[1], HOLDINGS[0]],
      [
        { symbol: "TSM", weightPct: 60 },
        { symbol: "INTC", weightPct: 40 },
      ],
      [
        { symbol: "tsm", weightPct: 50 },
        { symbol: "INTC", weightPct: 50 },
      ],
    ]) {
      expect((await api.post(other)).headers.get("X-Cache")).toBe("MISS");
    }
    api.advance(CACHE_TTL_SECONDS + 1);
    expect((await api.post(HOLDINGS)).headers.get("X-Cache")).toBe("MISS");
    expect(weightsCacheKey(HOLDINGS)).not.toBe(weightsCacheKey([HOLDINGS[1], HOLDINGS[0]]));
  });

  it("does not cache rejected input", async () => {
    const api = weightsApi();
    const bad = [{ symbol: "TSM", weightPct: 60 }];
    expect((await api.post(bad)).status).toBe(422);
    expect((await api.post(bad)).status).toBe(422);
  });
});

describe("demo warm-up", () => {
  function warmSetup() {
    let clock = Date.parse("2026-10-10T12:00:00Z");
    const cache = memoryApiCache(() => clock);
    const state = { down: false };
    const deps: WarmDeps = {
      cache,
      signals: async () => SIGNALS,
      stocks: { generate: gemini(state), search: async () => [MARKET], rateLimit: allow },
    };
    return { cache, deps, state, advance: (seconds: number) => (clock += seconds * 1000) };
  }

  it("caches the stocks answer and the weights request the frontend sends next", async () => {
    const s = warmSetup();
    const report = await warmIdea(DEMO_IDEAS[0], s.deps);
    expect(report).toMatchObject({
      result: "refreshed",
      source: "gemini",
      symbols: ["TSM", "NVDA", "AMD"],
      weights: "adjusted",
    });

    // A visitor typing the idea now gets both steps from the cache.
    const stocks = createStocksHandler({ ...s.deps.stocks, cache: s.cache });
    const res = await stocks.POST(
      new Request("https://api.test/api/stocks", {
        method: "POST",
        body: JSON.stringify({ idea: "ai chips and taiwan risk" }),
      }),
    );
    expect(res.headers.get("X-Cache")).toBe("HIT");
    const weights = createWeightsHandler({
      signals: s.deps.signals,
      rateLimit: allow,
      cache: s.cache,
    });
    const controllerRequest = {
      idea: DEMO_IDEAS[0],
      holdings: [
        { symbol: "TSM", weightPct: 33.33 },
        { symbol: "NVDA", weightPct: 33.33 },
        { symbol: "AMD", weightPct: 33.34 },
      ],
    };
    const w = await weights.POST(
      new Request("https://api.test/api/weights", {
        method: "POST",
        body: JSON.stringify(controllerRequest),
      }),
    );
    expect(w.headers.get("X-Cache")).toBe("HIT");
  });

  it("keeps the previous AI answer alive when Gemini is down, instead of a fallback", async () => {
    const s = warmSetup();
    await warmIdea(DEMO_IDEAS[0], s.deps);
    s.advance(CACHE_TTL_SECONDS - 60);
    s.state.down = true;
    const report = await warmIdea(DEMO_IDEAS[0], s.deps);
    expect(report).toMatchObject({ result: "kept", symbols: ["TSM", "NVDA", "AMD"] });
    s.advance(120); // past the original expiry
    const entry = await s.cache.get<{ source: string }>("stocks", stocksCacheKey(DEMO_IDEAS[0]));
    expect(entry?.value.source).toBe("gemini");
  });

  it("reports failure when Gemini is down and nothing was cached before", async () => {
    const s = warmSetup();
    s.state.down = true;
    expect(await warmIdea(DEMO_IDEAS[3], s.deps)).toMatchObject({ result: "failed", symbols: [] });
    expect(await s.cache.get("stocks", stocksCacheKey(DEMO_IDEAS[3]))).toBeNull();
  });

  it("refreshes missing ideas first, then the one expiring soonest", async () => {
    const s = warmSetup();
    expect(await stalestIdea(s.cache)).toBe(DEMO_IDEAS[0]);
    await warmIdea(DEMO_IDEAS[0], s.deps);
    expect(await stalestIdea(s.cache)).toBe(DEMO_IDEAS[1]);
    for (const idea of DEMO_IDEAS.slice(1)) {
      s.advance(60);
      await warmIdea(idea, s.deps);
    }
    expect(await stalestIdea(s.cache)).toBe(DEMO_IDEAS[0]);
  });

  it("covers exactly the four demo ideas", () => {
    expect(DEMO_IDEAS).toEqual([
      "AI chips and Taiwan risk",
      "Fed rate cuts and housing",
      "Clean energy after the election",
      "Crypto regulation",
    ]);
  });
});
