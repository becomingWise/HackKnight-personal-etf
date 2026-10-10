// Odds history: recording, backfill, the tick job and the read endpoints, with Tiger and
// Polymarket replaced by in-memory fakes. (The SQL itself is exercised against the live
// database by `pnpm try:odds`.)
import { describe, expect, it } from "vitest";
import type { StoredBasket } from "../baskets/store";
import { parseHistory, parseMarket, type MarketSnapshot } from "../polymarket/markets";
import { createOddsHandlers, isCronAuthorized } from "./handler";
import { RANGES, type MarketRow, type OddsRepo, type Tick } from "./repo";
import { backfillMarket, parseRange, recordObservations, runTick, type OddsDeps } from "./service";

const NOW = new Date("2026-10-10T12:34:56.000Z");

function fakeRepo(cited: string[] = []) {
  const markets = new Map<string, MarketRow>();
  const ticks: Tick[] = [];
  const refreshed: [Date, Date][] = [];
  const repo: OddsRepo = {
    async upsertMarkets(list) {
      for (const m of list) {
        const old = markets.get(m.id);
        markets.set(m.id, {
          id: m.id,
          question: m.question,
          url: m.url ?? old?.url ?? null,
          yesTokenId: m.yesTokenId ?? old?.yesTokenId ?? null,
          endDate: m.endDate ?? old?.endDate ?? null,
          closed: (old?.closed ?? false) || (m.closed ?? false),
          backfilledAt: old?.backfilledAt ?? null,
          lastTickAt: old?.lastTickAt ?? null,
        });
      }
    },
    async insertTicks(list) {
      let inserted = 0;
      for (const t of list) {
        const dup = ticks.some(
          (x) => x.marketId === t.marketId && x.time.getTime() === t.time.getTime(),
        );
        if (!dup) {
          ticks.push(t);
          inserted++;
        }
      }
      return inserted;
    },
    async markets(ids) {
      return ids.flatMap((id) => (markets.has(id) ? [markets.get(id)!] : []));
    },
    async citedMarketIds() {
      return cited;
    },
    async markBackfilled(id) {
      markets.set(id, { ...markets.get(id)!, backfilledAt: NOW.toISOString() });
    },
    async markTicked(ids, at) {
      for (const id of ids) markets.set(id, { ...markets.get(id)!, lastTickAt: at.toISOString() });
    },
    async refreshHourly(from, to) {
      refreshed.push([from, to]);
    },
    async series(ids, range, now) {
      const start = now.getTime() - RANGES[range].spanSeconds * 1000;
      return {
        ms: 1.5,
        points: ticks
          .filter((t) => ids.includes(t.marketId) && t.time.getTime() >= start)
          .sort((a, b) => a.time.getTime() - b.time.getTime())
          .map((t) => ({ marketId: t.marketId, t: t.time, p: t.probability })),
      };
    },
  };
  return { repo, markets, ticks, refreshed };
}

const snapshot = (id: string, over: Partial<MarketSnapshot> = {}): MarketSnapshot => ({
  id,
  question: `Question ${id}?`,
  url: `https://polymarket.com/event/e${id}`,
  yesTokenId: `tok${id}`,
  endDate: "2027-01-01T00:00:00Z",
  closed: false,
  probability: 0.4,
  ...over,
});

function setup(cited: string[] = [], live: MarketSnapshot[] = []) {
  const fake = fakeRepo(cited);
  const calls = { markets: [] as string[][], history: [] as string[] };
  const deps: OddsDeps = {
    repo: fake.repo,
    now: () => NOW,
    fetchMarkets: async (ids) => {
      calls.markets.push(ids);
      return live.filter((m) => ids.includes(m.id));
    },
    fetchHistory: async (tokenId, interval, bucket) => {
      calls.history.push(`${tokenId}:${interval}:${bucket}`);
      const step = bucket * 1000;
      const end = Math.floor(NOW.getTime() / step) * step;
      return [3, 2, 1].map((i) => ({ time: new Date(end - i * step), probability: 0.3 + i / 100 }));
    },
  };
  return { ...fake, deps, calls };
}

describe("recordObservations", () => {
  it("stores the market and one tick per observation, ignoring non-market ids and bad odds", async () => {
    const s = setup();
    const stored = await recordObservations(
      [
        {
          id: "101",
          question: "A?",
          url: "https://polymarket.com/event/a",
          yesTokenId: "t",
          probability: 0.25,
        },
        {
          id: "102",
          question: "B?",
          probability: 0.5,
          observedAt: new Date("2026-10-10T12:00:00Z"),
        },
        { id: "not-a-market", question: "C?", probability: 0.5 },
        { id: "103", question: "D?", probability: 1.7 },
      ],
      "stocks",
      s.deps,
    );
    expect(stored).toBe(2);
    expect([...s.markets.keys()]).toEqual(["101", "102"]);
    expect(s.ticks).toEqual([
      { time: NOW, marketId: "101", probability: 0.25, source: "stocks" },
      {
        time: new Date("2026-10-10T12:00:00Z"),
        marketId: "102",
        probability: 0.5,
        source: "stocks",
      },
    ]);
  });
});

describe("backfillMarket", () => {
  it("loads 30 days hourly and 1 day at 10 minutes, refreshes the aggregate, and marks the market", async () => {
    const s = setup();
    await s.repo.upsertMarkets([snapshot("7")]);
    const [row] = await s.repo.markets(["7"]);
    const inserted = await backfillMarket(row, s.deps);

    expect(s.calls.history).toEqual(["tok7:1m:3600", "tok7:1d:600"]);
    expect(inserted).toBe(6);
    expect(s.ticks.every((t) => t.source === "backfill" && t.marketId === "7")).toBe(true);
    expect(s.refreshed).toHaveLength(1);
    expect(s.refreshed[0][0].getTime()).toBeLessThan(
      Math.min(...s.ticks.map((t) => t.time.getTime())),
    );
    expect((await s.repo.markets(["7"]))[0].backfilledAt).not.toBeNull();
  });

  it("looks up the token on Polymarket when it is unknown, and still marks markets without one", async () => {
    const s = setup(
      [],
      [snapshot("8", { yesTokenId: "tok8" }), snapshot("9", { yesTokenId: null })],
    );
    await s.repo.upsertMarkets([
      { id: "8", question: "Eight?" },
      { id: "9", question: "Nine?" },
    ]);
    for (const row of await s.repo.markets(["8", "9"])) await backfillMarket(row, s.deps);
    expect(s.calls.history).toEqual(["tok8:1m:3600", "tok8:1d:600"]);
    expect((await s.repo.markets(["8", "9"])).every((m) => m.backfilledAt)).toBe(true);
  });
});

describe("runTick", () => {
  it("writes one tick per open cited market, stamped on the minute, and is idempotent", async () => {
    const s = setup(
      ["1", "2", "3"],
      [
        snapshot("1", { probability: 0.11 }),
        snapshot("2", { probability: null }),
        snapshot("3", { probability: 1, closed: true }),
      ],
    );
    const first = await runTick(s.deps);
    expect(first).toMatchObject({ markets: 3, ticks: 2, closed: 1 });
    const live = s.ticks.filter((t) => t.source === "tick");
    expect(live.map((t) => [t.marketId, t.probability])).toEqual([
      ["1", 0.11],
      ["3", 1],
    ]);
    expect(live[0].time.toISOString()).toBe("2026-10-10T12:34:00.000Z");
    expect((await s.repo.markets(["1"]))[0].lastTickAt).toBe("2026-10-10T12:34:00.000Z");

    // Same minute again: nothing new. The closed market is no longer polled.
    const second = await runTick(s.deps);
    expect(second.ticks).toBe(0);
    expect(s.calls.markets.at(-1)).toEqual(["1", "2"]);
  });

  it("backfills newly cited markets, a few per run", async () => {
    const ids = ["1", "2", "3", "4", "5", "6"];
    const s = setup(
      ids,
      ids.map((id) => snapshot(id)),
    );
    expect((await runTick(s.deps)).backfilled).toBe(4);
    expect((await runTick(s.deps)).backfilled).toBe(2);
    expect((await runTick(s.deps)).backfilled).toBe(0);
  });

  it("does nothing when no basket cites a market", async () => {
    const s = setup([]);
    expect(await runTick(s.deps)).toMatchObject({ markets: 0, ticks: 0, backfilled: 0 });
    expect(s.calls.markets).toEqual([]);
  });
});

const BASKET: StoredBasket = {
  id: "abcdefgh",
  createdAt: "2026-10-10T10:00:00.000Z",
  idea: "chips",
  summary: "s",
  source: "gemini",
  stocks: [],
  weights: { status: "adjusted", explanation: "e", holdings: [], evidence: [] },
  markets: [
    {
      id: "1",
      title: "One?",
      url: "https://polymarket.com/event/e1",
      outcome: "Yes",
      probability: 0.3,
      observedAt: "2026-10-10T10:00:00.000Z",
      change7d: null,
      citedBy: ["stocks"],
    },
    {
      id: null,
      title: "Unknown?",
      url: "https://polymarket.com/event/x",
      outcome: "Yes",
      probability: 0.5,
      observedAt: "2026-10-10T10:00:00.000Z",
      change7d: null,
      citedBy: ["weights"],
    },
    {
      id: "2",
      title: "Two?",
      url: "https://polymarket.com/event/e2",
      outcome: "Yes",
      probability: 0.6,
      observedAt: "2026-10-10T10:00:00.000Z",
      change7d: 0.01,
      citedBy: ["stocks", "weights"],
    },
  ],
};

function api(secret: string | undefined = "s3cret") {
  const s = setup(
    ["1", "2"],
    [snapshot("1", { probability: 0.35 }), snapshot("2"), snapshot("55")],
  );
  const handlers = createOddsHandlers({
    odds: s.deps,
    baskets: {
      insert: async () => ({ id: "x", createdAt: "" }),
      get: async (id) => (id === BASKET.id ? BASKET : null),
    },
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    cronSecret: () => secret,
  });
  const get = (path: string, headers: Record<string, string> = {}) =>
    new Request(`https://prophetf.vercel.app${path}`, { headers });
  return { ...s, handlers, get };
}

describe("GET /api/markets/{id}/history", () => {
  it("tracks an unseen market, backfills it once, and returns its series", async () => {
    const a = api();
    const res = await a.handlers.marketHistory(a.get("/api/markets/55/history?range=1d"), "55");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.market).toEqual({
      id: "55",
      question: "Question 55?",
      url: "https://polymarket.com/event/e55",
      endDate: "2027-01-01T00:00:00Z",
      closed: false,
    });
    expect(body).toMatchObject({ range: "1d", bucketSeconds: 600, queryMs: 1.5 });
    expect(body.points.length).toBeGreaterThan(0);
    expect(body.points[0]).toEqual({ t: expect.any(String), p: expect.any(Number) });
    expect(body.current).toBe(body.points.at(-1).p);
    expect(body.change).toBeCloseTo(body.points.at(-1).p - body.points[0].p, 4);

    await a.handlers.marketHistory(a.get("/api/markets/55/history"), "55");
    expect(a.calls.history).toEqual(["tok55:1m:3600", "tok55:1d:600"]);
  });

  it("defaults to 7d, rejects unknown ranges, and 404s unknown or malformed ids", async () => {
    const a = api();
    expect(
      (await (await a.handlers.marketHistory(a.get("/api/markets/55/history"), "55")).json()).range,
    ).toBe("7d");
    const bad = await a.handlers.marketHistory(a.get("/api/markets/55/history?range=1y"), "55");
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.code).toBe("invalid_request");
    expect((await a.handlers.marketHistory(a.get("/api/markets/999/history"), "999")).status).toBe(
      404,
    );
    expect((await a.handlers.marketHistory(a.get("/api/markets/abc/history"), "abc")).status).toBe(
      404,
    );
  });
});

describe("GET /api/baskets/{id}/odds", () => {
  it("returns every cited market in one call, with odds at creation and since", async () => {
    const a = api();
    const res = await a.handlers.basketOdds(
      a.get("/api/baskets/abcdefgh/odds?range=30d", { Origin: "https://becomingwise.github.io" }),
      "abcdefgh",
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://becomingwise.github.io");
    const body = await res.json();
    expect(body).toMatchObject({ id: "abcdefgh", range: "30d", bucketSeconds: 10800 });
    expect(body.markets.map((m: { id: string }) => m.id)).toEqual(["1", "2"]);
    expect(body.markets[0]).toMatchObject({
      title: "One?",
      probabilityAtCreation: 0.3,
      citedBy: ["stocks"],
      closed: false,
    });
    expect(body.markets[0].points.length).toBeGreaterThan(0);
    expect(body.markets[0].changeSinceCreation).toBeCloseTo(body.markets[0].current - 0.3, 4);
    expect(body.untracked).toEqual(["Unknown?"]);
  });

  it("404s unknown baskets and rejects bad ranges", async () => {
    const a = api();
    expect(
      (await a.handlers.basketOdds(a.get("/api/baskets/zzzzzzzz/odds"), "zzzzzzzz")).status,
    ).toBe(404);
    expect(
      (await a.handlers.basketOdds(a.get("/api/baskets/abcdefgh/odds?range=x"), "abcdefgh")).status,
    ).toBe(400);
  });
});

describe("/api/jobs/tick", () => {
  it("requires the bearer secret", async () => {
    const a = api();
    for (const headers of [{}, { Authorization: "Bearer wrong!" }, { Authorization: "s3cret" }]) {
      const res = await a.handlers.tick(a.get("/api/jobs/tick", headers as Record<string, string>));
      expect(res.status).toBe(401);
    }
    expect(a.ticks).toHaveLength(0);
    const ok = await a.handlers.tick(a.get("/api/jobs/tick", { Authorization: "Bearer s3cret" }));
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ ok: true, markets: 2, ticks: 2 });
  });

  it("never authorizes when no secret is configured", () => {
    const request = new Request("https://x.test", { headers: { Authorization: "Bearer " } });
    expect(isCronAuthorized(request, undefined)).toBe(false);
    expect(isCronAuthorized(request, "")).toBe(false);
  });
});

describe("Polymarket parsers", () => {
  const raw = {
    id: 1633611,
    question: " Will China invade Taiwan by December 31, 2027? ",
    active: true,
    closed: false,
    outcomes: '["Yes", "No"]',
    outcomePrices: '["0.105", "0.895"]',
    bestBid: 0.1,
    bestAsk: 0.11,
    lastTradePrice: 0.1,
    version: "v1",
    clobTokenIds: '["111", "222"]',
    positionIds: ["999", "998"],
    endDate: "2028-01-01T04:59:00Z",
    events: [{ slug: "will-china-invade-taiwan-by-december-31-2027" }],
  };

  it("reads a v1 market: id, URL from the event, midpoint price, clob token", () => {
    expect(parseMarket(raw)).toEqual({
      id: "1633611",
      question: "Will China invade Taiwan by December 31, 2027?",
      url: "https://polymarket.com/event/will-china-invade-taiwan-by-december-31-2027",
      yesTokenId: "111",
      endDate: "2028-01-01T04:59:00Z",
      closed: false,
      probability: 0.105,
    });
  });

  it("uses positionIds on v2 markets and never requires clobTokenIds", () => {
    expect(parseMarket({ ...raw, version: "v2" })!.yesTokenId).toBe("999");
    expect(parseMarket({ ...raw, version: "v2", clobTokenIds: undefined })!.yesTokenId).toBe("999");
    expect(
      parseMarket({ ...raw, clobTokenIds: undefined, positionIds: undefined })!.yesTokenId,
    ).toBeNull();
  });

  it("prices a resolved market at its payout and a never-traded one at null", () => {
    expect(parseMarket({ ...raw, closed: true, outcomePrices: '["1", "0"]' })).toMatchObject({
      closed: true,
      probability: 1,
    });
    expect(
      parseMarket({ ...raw, resolutionStatus: "resolved", outcomePrices: '["0.5", "0.5"]' }),
    ).toMatchObject({ closed: true, probability: 0.5 });
    expect(
      parseMarket({ ...raw, bestBid: 0, bestAsk: 1, lastTradePrice: 0 })!.probability,
    ).toBeNull();
    expect(parseMarket({ nope: true })).toBeNull();
  });

  it("parses price history pages and drops the unbucketed latest point", () => {
    const page = {
      data: [
        { timestamp: 1789002000, price: 0.645, resolution_seconds: 3600 },
        { timestamp: 1789005600, price: 0.675, resolution_seconds: 3600 },
        { timestamp: 1791595130, price: 0.21, resolution_seconds: 0 },
        { timestamp: 1789009200, price: 4, resolution_seconds: 3600 },
      ],
      pagination: { has_more: true, next_cursor: "abc" },
    };
    const parsed = parseHistory(page);
    expect(parsed.points).toEqual([
      { time: new Date(1789002000_000), probability: 0.645 },
      { time: new Date(1789005600_000), probability: 0.675 },
    ]);
    expect(parsed.nextCursor).toBe("abc");
    expect(
      parseHistory({ data: [], pagination: { has_more: false, next_cursor: null } }).nextCursor,
    ).toBeNull();
    expect(parseHistory("garbage")).toEqual({ points: [], nextCursor: null });
  });

  it("parses ranges", () => {
    expect(parseRange(null)).toBe("7d");
    expect(parseRange("1d")).toBe("1d");
    expect(parseRange("30d")).toBe("30d");
    expect(parseRange("1y")).toBeNull();
  });
});
