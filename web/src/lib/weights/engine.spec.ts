// The cases of /backend/tests/test_engine.py and test_weights_api.py, ported one to one.
// (expansion_suggestions and trade_ticket are not ported: POST /api/weights does not use them.)
import { describe, expect, it } from "vitest";
import { corsHeaders } from "../http/cors";
import { reweight, scopeHoldings, type Signal } from "./engine";
import { createWeightsHandler } from "./handler";
import { resolveSignal } from "./signals";

const SECTORS = [
  {
    id: "semis",
    name: "Semis",
    holdings: [
      { symbol: "TSM", name: "TSMC", base: 60 },
      { symbol: "INTC", name: "Intel", base: 40 },
    ],
  },
  { id: "defense", name: "Defense", holdings: [{ symbol: "LMT", name: "Lockheed", base: 1 }] },
];

const signal = (
  price: number | null,
  weekChange: number,
  betas: Record<string, number>,
  id = "taiwan",
): Signal => ({ id, label: id, price, changes: { "1w": weekChange }, betas });

const bySymbol = <T extends { symbol: string }>(rows: T[]) =>
  Object.fromEntries(rows.map((r) => [r.symbol, r]));

describe("engine (test_engine.py)", () => {
  it("scope gives each sector an equal share", () => {
    const rows = scopeHoldings(SECTORS, ["semis", "defense"]);
    const bases = Object.fromEntries(rows.map((r) => [r.symbol, r.base]));
    expect(bases.TSM).toBeCloseTo(30);
    expect(bases.INTC).toBeCloseTo(20);
    expect(bases.LMT).toBeCloseTo(50);
  });

  it("no movement keeps base weights", () => {
    const holdings = scopeHoldings(SECTORS, ["semis"]);
    const rows = bySymbol(reweight(holdings, [signal(0.1, 0.0, { TSM: -1.0, INTC: 0.5 })]));
    expect(rows.TSM.weight_pct).toBeCloseTo(60);
    expect(rows.INTC.change_pct).toBeCloseTo(0);
  });

  it("rising odds tilt by beta sign", () => {
    const holdings = scopeHoldings(SECTORS, ["semis"]);
    // Odds rose 10 points this week; TSM is hurt, Intel helped.
    const rows = bySymbol(
      reweight(holdings, [signal(0.2, 0.1, { TSM: -1.0, INTC: 0.5 })], { sensitivity: 2 }),
    );
    expect(rows.TSM.multiplier).toBeCloseTo(0.8);
    expect(rows.INTC.multiplier).toBeCloseTo(1.1);
    // 60*0.8 = 48, 40*1.1 = 44 -> renormalized
    expect(rows.TSM.weight_pct).toBeCloseTo((100 * 48) / 92);
    expect(rows.TSM.weight_pct + rows.INTC.weight_pct).toBeCloseTo(100);
  });

  it("what-if override replaces live odds", () => {
    const holdings = scopeHoldings(SECTORS, ["semis"]);
    const rows = bySymbol(
      reweight(holdings, [signal(0.1, 0.0, { TSM: -1.0 })], {
        sensitivity: 1,
        overrides: { taiwan: 0.6 },
      }),
    );
    expect(rows.TSM.multiplier).toBeCloseTo(0.5);
    expect(rows.TSM.contributions[0].delta).toBeCloseTo(0.5);
  });

  it("multiplier is clipped and all-zero falls back to base", () => {
    const holdings = scopeHoldings(SECTORS, ["semis"]);
    const rows = bySymbol(
      reweight(holdings, [signal(0.9, 0.0, { TSM: -5.0, INTC: -5.0 })], {
        overrides: { taiwan: 1.0 },
        sensitivity: 10,
      }),
    );
    expect(rows.TSM.multiplier).toBe(0);
    expect(rows.TSM.weight_pct).toBeCloseTo(60);
  });

  it("unavailable signal is ignored", () => {
    const holdings = scopeHoldings(SECTORS, ["semis"]);
    const gone: Signal = { id: "gone", label: "gone", price: null, betas: { TSM: -1.0 } };
    expect(bySymbol(reweight(holdings, [gone])).TSM.contributions).toEqual([]);
  });
});

const LIVE: Signal[] = [
  {
    id: "taiwan",
    label: "China invades Taiwan",
    status: "live",
    price: 0.3,
    question: "Will China invade Taiwan by December 31, 2027?",
    url: "https://polymarket.com/event/taiwan",
    changes: { "1w": 0.1 },
    betas: { TSM: -1.0, INTC: 0.5 },
  },
  { id: "gone", label: "Closed", status: "unavailable", price: null, betas: { TSM: 1.0 } },
];

function client(over: Partial<Parameters<typeof createWeightsHandler>[0]> = {}) {
  const handler = createWeightsHandler({
    signals: async () => LIVE,
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    ...over,
  });
  const post = (holdings: unknown, headers: Record<string, string> = {}) =>
    handler.POST(
      new Request("https://api.test/api/weights", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify({ idea: "chips", holdings }),
      }),
    );
  return { ...handler, post };
}

describe("POST /api/weights (test_weights_api.py)", () => {
  it("adjusts known symbols and keeps the contract", async () => {
    const body = await (
      await client().post([
        { symbol: "TSM", weightPct: 50 },
        { symbol: "INTC", weightPct: 30 },
        { symbol: "SOLAR_DEMO", weightPct: 20 },
      ])
    ).json();
    expect(body.status).toBe("adjusted");
    expect(body.holdings.map((h: { symbol: string }) => h.symbol)).toEqual([
      "TSM",
      "INTC",
      "SOLAR_DEMO",
    ]);
    const weights = Object.fromEntries(
      body.holdings.map((h: { symbol: string; weightPct: number }) => [h.symbol, h.weightPct]),
    );
    expect(Math.round((weights.TSM + weights.INTC + weights.SOLAR_DEMO) * 100) / 100).toBe(100);
    expect(weights.TSM).toBeLessThan(50);
    expect(weights.INTC).toBeGreaterThan(30);
    expect(body.evidence).toHaveLength(1); // the unavailable market is never cited
    const [ev] = body.evidence;
    expect(ev.url.startsWith("https://")).toBe(true);
    expect(ev.probability).toBeGreaterThanOrEqual(0);
    expect(ev.probability).toBeLessThanOrEqual(1);
    expect(ev.outcome).toBe("Yes");
    expect(body.explanation).toContain("TSM");
  });

  it("returns input weights verbatim for unrelated symbols", async () => {
    const holdings = [
      { symbol: "SOLAR_DEMO", weightPct: 33.33 },
      { symbol: "TIDAL_DEMO", weightPct: 33.33 },
      { symbol: "GRID_DEMO", weightPct: 33.34 },
    ];
    const body = await (await client().post(holdings)).json();
    expect(body.status).toBe("unchanged");
    expect(body.holdings).toEqual(holdings);
    expect(body.evidence).toEqual([]);
  });

  it("matches lowercase symbols but echoes them as given", async () => {
    const body = await (
      await client().post([
        { symbol: "tsm", weightPct: 50 },
        { symbol: "intc", weightPct: 50 },
      ])
    ).json();
    expect(body.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(["tsm", "intc"]);
  });

  it("rejects bad input with 422", async () => {
    const c = client();
    const dup = await c.post([
      { symbol: "TSM", weightPct: 60 },
      { symbol: "TSM", weightPct: 40 },
    ]);
    expect(dup.status).toBe(422);
    expect((await dup.json()).detail).toBe("Duplicate symbols.");
    expect((await c.post([{ symbol: "TSM", weightPct: 60 }])).status).toBe(422);
  });
});

describe("POST /api/weights (this deployment's extras)", () => {
  it("answers the CORS preflight and tags responses for the frontend origins", async () => {
    const c = client();
    const origin = "https://becomingwise.github.io";
    const pre = c.OPTIONS(
      new Request("https://api.test/api/weights", {
        method: "OPTIONS",
        headers: { Origin: origin },
      }),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    const res = await c.post([{ symbol: "TSM", weightPct: 100 }], { Origin: origin });
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    expect(
      corsHeaders(new Request("https://x.test", { headers: { Origin: "https://evil.example" } })),
    ).not.toHaveProperty("Access-Control-Allow-Origin");
  });

  it("returns 429 when rate limited and 502 when Polymarket lookup throws", async () => {
    const limited = await client({
      rateLimit: async () => ({ allowed: false, retryAfterSeconds: 7 }),
    }).post([{ symbol: "TSM", weightPct: 100 }]);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("7");

    const broken = await client({
      signals: async () => {
        throw new Error("network");
      },
    }).post([{ symbol: "TSM", weightPct: 100 }]);
    expect(broken.status).toBe(502);
  });
});

describe("resolveSignal (polymarket.py _resolve)", () => {
  const cfg = {
    id: "taiwan",
    label: "China invades Taiwan",
    query: "China invade Taiwan",
    match: "by December 31, 2027",
    betas: { TSM: -1 },
  };
  const market = (over: Record<string, unknown>) => ({
    question: "Will China invade Taiwan by December 31, 2027?",
    active: true,
    closed: false,
    outcomePrices: '["0.105", "0.895"]',
    volume: "1000",
    oneWeekPriceChange: 0.015,
    ...over,
  });

  it("picks the highest-volume live market whose question contains the match text", () => {
    const payload = {
      events: [
        { slug: "closed-event", closed: true, markets: [market({ volume: "999999" })] },
        {
          slug: "taiwan-2027",
          markets: [
            market({ question: "Will China invade Taiwan by June 30, 2027?", volume: "5000" }),
            market({ volume: "1000" }),
            market({ volume: "3000", outcomePrices: '["0.11", "0.89"]' }),
            market({ volume: "9000", closed: true }),
            market({ volume: "9000", outcomePrices: '["1", "0"]' }),
          ],
        },
      ],
    };
    expect(resolveSignal(cfg, payload)).toMatchObject({
      status: "live",
      price: 0.11,
      url: "https://polymarket.com/event/taiwan-2027",
      changes: { "1w": 0.015 },
    });
  });

  it("is unavailable when nothing matches or the payload is malformed", () => {
    expect(resolveSignal(cfg, { events: [] })).toMatchObject({
      status: "unavailable",
      price: null,
    });
    expect(resolveSignal(cfg, null).status).toBe("unavailable");
    expect(
      resolveSignal(cfg, { events: [{ slug: "x", markets: [market({ outcomePrices: "?" })] }] })
        .status,
    ).toBe("unavailable");
  });
});
