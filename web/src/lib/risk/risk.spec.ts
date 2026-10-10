// POST /api/risk: a basket's move if each linked Polymarket event happens or doesn't.
import { describe, expect, it, vi } from "vitest";
import type { Signal } from "../weights/engine";
import { createRiskHandler, type RiskDeps } from "./handler";
import { RiskInputError, eventRisk } from "./risk";

const FED: Signal = {
  id: "fed",
  label: "Fed cuts",
  betas: { TLT: 0.6, JPM: -0.3 },
  status: "live",
  price: 0.68,
  question: "Will the Fed cut rates in December?",
  url: "https://polymarket.com/event/fed",
};
const TAIWAN: Signal = {
  id: "taiwan",
  label: "Taiwan",
  betas: { TSM: -1.0 },
  status: "live",
  price: 0.1,
  question: "Will China invade Taiwan by 2027?",
  url: "https://polymarket.com/event/taiwan",
};
const DEAD: Signal = {
  id: "dead",
  label: "Dead",
  betas: { TLT: 1.0 },
  status: "unavailable",
  price: null,
};
const NOW = new Date("2026-10-10T12:00:00.000Z");

const basket = (...h: [string, number][]) => ({
  holdings: h.map(([symbol, weightPct]) => ({ symbol, weightPct })),
});

describe("eventRisk", () => {
  it("moves the basket by its exposure times the odds still to move", () => {
    const out = eventRisk(basket(["TLT", 50], ["JPM", 50]), [FED], NOW);
    // Basket beta 0.5 * 0.6 + 0.5 * -0.3 = 0.15 app units = 1.5% per 100-pt move.
    expect(out.markets).toHaveLength(1);
    const m = out.markets[0];
    expect(m.ifYesPct).toBe(0.48);
    expect(m.ifNoPct).toBe(-1.02);
    expect(m.probability).toBe(0.68);
    expect(m.title).toBe("Will the Fed cut rates in December?");
    expect(m.observedAt).toBe(NOW.toISOString());
    expect(m.drivers).toEqual([
      { symbol: "TLT", weightPct: 50, beta: 0.6, ifYesPct: expect.any(Number) },
      { symbol: "JPM", weightPct: 50, beta: -0.3, ifYesPct: expect.any(Number) },
    ]);
  });

  it("is zero on average once weighted by the market's own probability", () => {
    for (const p of [0.05, 0.32, 0.68, 0.97]) {
      const m = eventRisk(basket(["TLT", 70], ["JPM", 30]), [{ ...FED, price: p }], NOW).markets[0];
      expect(p * m.ifYesPct + (1 - p) * m.ifNoPct).toBeCloseTo(0, 3); // up to rounding
    }
  });

  it("lists symbols with no live linked market and ignores dead markets", () => {
    const out = eventRisk(basket(["TLT", 40], ["AAPL", 30], ["tsm", 30]), [FED, TAIWAN, DEAD], NOW);
    expect(out.uncovered).toEqual(["AAPL"]);
    expect(out.markets.map((m) => m.title)).toEqual([
      "Will China invade Taiwan by 2027?", // swing 3.0% beats Fed's 2.4%
      "Will the Fed cut rates in December?",
    ]);
    // Symbols are matched case-insensitively and echoed as sent.
    expect(out.markets[0].drivers[0].symbol).toBe("tsm");
  });

  it("returns no markets when nothing is linked", () => {
    const out = eventRisk(basket(["AAPL", 100]), [FED], NOW);
    expect(out.markets).toEqual([]);
    expect(out.uncovered).toEqual(["AAPL"]);
    expect(out.note).toMatch(/not expected returns/);
  });

  it("rejects duplicate symbols and weights that do not total 100", () => {
    expect(() => eventRisk(basket(["TLT", 50], ["tlt", 50]), [FED], NOW)).toThrow(RiskInputError);
    expect(() => eventRisk(basket(["TLT", 50], ["JPM", 40]), [FED], NOW)).toThrow(/total 100/);
  });
});

function deps(overrides: Partial<RiskDeps> = {}): RiskDeps {
  return {
    signals: async () => [FED, TAIWAN],
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    now: () => NOW,
    ...overrides,
  };
}

const post = (body: unknown) =>
  new Request("https://prophetf.vercel.app/api/risk", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://becomingwise.github.io" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("POST /api/risk", () => {
  it("answers with event risk and CORS for the website", async () => {
    const res = await createRiskHandler(deps()).POST(post(basket(["TLT", 50], ["JPM", 50])));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("https://becomingwise.github.io");
    const body = await res.json();
    expect(body.markets[0].ifYesPct).toBeCloseTo(0.48, 10);
    expect(body.basis).toMatch(/hand-set/);
  });

  it("accepts the same body as /api/weights, idea included", async () => {
    const res = await createRiskHandler(deps()).POST(
      post({ idea: "rates", ...basket(["TLT", 100]) }),
    );
    expect(res.status).toBe(200);
  });

  it("rejects bad input with 422", async () => {
    const handler = createRiskHandler(deps());
    for (const body of ["not json", { holdings: [] }, basket(["TLT", 50], ["JPM", 40])]) {
      const res = await handler.POST(post(body));
      expect(res.status).toBe(422);
      expect((await res.json()).error.code).toBe("invalid_request");
    }
  });

  it("rate-limits per IP with Retry-After", async () => {
    const res = await createRiskHandler(
      deps({ rateLimit: async () => ({ allowed: false, retryAfterSeconds: 17 }) }),
    ).POST(post(basket(["TLT", 100])));
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("17");
  });

  it("returns 502 when the Polymarket lookup fails", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const res = await createRiskHandler(
      deps({ signals: async () => Promise.reject(new Error("down")) }),
    ).POST(post(basket(["TLT", 100])));
    expect(res.status).toBe(502);
    expect((await res.json()).error.code).toBe("upstream_error");
    log.mockRestore();
  });
});
