import { describe, expect, it } from "vitest";
import { parseSearch } from "./search";

const base = {
  id: "1",
  question: "Will X happen?",
  active: true,
  closed: false,
  outcomes: '["Yes", "No"]',
  outcomePrices: '["0.075", "0.925"]',
  bestBid: 0.07,
  bestAsk: 0.08,
  lastTradePrice: 0.07,
  liquidityNum: 1000,
  volumeNum: 5000,
  oneWeekPriceChange: -0.01,
  endDate: "2027-07-01T03:59:00Z",
};

const payload = (markets: unknown[], event: Record<string, unknown> = {}) => ({
  events: [{ title: "Event", slug: "event-slug", closed: false, markets, ...event }],
});

describe("parseSearch", () => {
  it("keeps live Yes/No markets and prices them at the midpoint", () => {
    const [m] = parseSearch(payload([base]));
    expect(m).toMatchObject({
      id: "1",
      question: "Will X happen?",
      url: "https://polymarket.com/event/event-slug",
      probability: 0.075,
      change7d: -0.01,
    });
  });

  it("uses the last trade when the spread is wider than 0.10", () => {
    const [m] = parseSearch(
      payload([{ ...base, bestBid: 0.2, bestAsk: 0.5, lastTradePrice: 0.31 }]),
    );
    expect(m.probability).toBe(0.31);
  });

  it("drops closed, resolved, never-traded, illiquid and non Yes/No markets", () => {
    const markets = [
      { ...base, id: "closed", closed: true },
      { ...base, id: "resolved", umaResolutionStatus: "resolved" },
      { ...base, id: "v2resolved", resolutionStatus: "resolved" },
      // The 0.5 placeholder of a market that never traded: empty book, no last trade.
      { ...base, id: "placeholder", bestBid: 0, bestAsk: 1, lastTradePrice: 0, liquidityNum: 0 },
      { ...base, id: "nobook", bestBid: undefined, bestAsk: undefined, lastTradePrice: 0 },
      { ...base, id: "illiquid", liquidityNum: 0 },
      { ...base, id: "teams", outcomes: '["Lakers", "Celtics"]' },
      { ...base, id: "inactive", active: false },
    ];
    expect(parseSearch(payload(markets))).toEqual([]);
  });

  it("skips closed events and tolerates malformed payloads", () => {
    expect(parseSearch(payload([base], { closed: true }))).toEqual([]);
    expect(parseSearch(null)).toEqual([]);
    expect(parseSearch({ events: [{ nope: 1 }, "x"] })).toEqual([]);
    expect(parseSearch({ events: [{ slug: "s", markets: [{ id: 5 }, base] }] })).toHaveLength(1);
  });

  it("accepts numeric strings and keeps at most three markets per event, by volume", () => {
    const markets = [1, 2, 3, 4].map((n) => ({
      ...base,
      id: String(n),
      volumeNum: String(n * 100),
      bestBid: "0.40",
      bestAsk: "0.42",
    }));
    const out = parseSearch(payload(markets));
    expect(out.map((m) => m.id)).toEqual(["4", "3", "2"]);
    expect(out[0].probability).toBe(0.41);
  });
});
