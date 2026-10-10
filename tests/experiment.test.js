import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { allocate, validateCaps, closeTimestamp, alignHistory, fitAssociation, association, qualifyAssociations, scenario } from "../experiment/math.js";
import { createSuggestions, previewSuggestions } from "../experiment/suggestions.js";
import { checkSelection } from "../agent/tools.js";
import { createGeminiCall } from "../agent/gemini.js";
import { eventHistory, stockEvents } from "../experiment/data.js";
import { createExperimentServer } from "../experiment/server.mjs";

const symbols = ["NVDA", "TSM", "AVGO", "AMD", "ASML", "MU", "INTC", "MSFT", "AAPL", "GOOGL"];
const stock = symbol => ({ symbol, name: symbol });

test("experiment Gemini produces 7–10 company candidates, leaving the old three-stock default usable", async () => {
  let sent;
  const find = createSuggestions({ callModel: async request => {
    sent = request;
    return { candidates: [{ content: { parts: [{ text: JSON.stringify({ clarity: "clear", why: "Chip companies match", summary: "Companies to explore", symbols: symbols.slice(0, 8) }) }] } }] };
  } });
  const result = await find({ idea: "AI chips" });
  assert.equal(result.stocks.length, 8);
  assert.equal(result.source, "gemini");
  assert.match(sent.body.generationConfig.responseJsonSchema.properties.symbols.description, /7 to 10/);
  assert.deepEqual(sent.body.generationConfig.responseJsonSchema.required, ["clarity", "why"]);
  assert.match(sent.body.systemInstruction.parts[0].text, /person chooses/);
  assert.equal(checkSelection(symbols.slice(0, 3)).ok, true);
  assert.equal(checkSelection(symbols.slice(0, 6), { min: 7, max: 10 }).ok, false);
  assert.equal(checkSelection([...symbols.slice(0, 6), "TLT"], { min: 7, max: 10, companiesOnly: true }).ok, false);
  assert.equal(checkSelection([...symbols, "XOM"], { min: 7, max: 10 }).ok, false);
});

test("explicit preview lists 10 candidates, rejects bad input and never adds holdings", () => {
  const preview = previewSuggestions({ idea: "AI and chips" });
  assert.equal(preview.stocks.length, 10);
  assert.equal(preview.source, "preview");
  assert.equal(preview.holdings, undefined);
  assert.throws(() => previewSuggestions({ idea: "" }));
});

test("invalid Gemini credentials produce an actionable error without masquerading as model exhaustion", async () => {
  const call = createGeminiCall({ apiKey: "test-only-not-a-real-key", fetch: async () => new Response(JSON.stringify({ error: { message: "API key not valid. Please pass a valid API key." } }), { status: 400 }) });
  await assert.rejects(call({ model: "gemini-3.5-flash-lite", body: {} }), err => err.code === "not_configured" && err.status === 503);
});

test("selected holdings get exact 100% equal weights, including after removals", () => {
  assert.deepEqual(allocate([]), []);
  for (const n of [1, 3, 7, 10]) {
    const holdings = allocate(symbols.slice(0, n).map(stock));
    assert.equal(Math.round(holdings.reduce((sum, h) => sum + h.weightPct, 0) * 100), 10000);
    assert.ok(Math.max(...holdings.map(h => h.weightPct)) - Math.min(...holdings.map(h => h.weightPct)) <= 0.010000001);
  }
  assert.deepEqual(allocate(symbols.slice(0, 2).map(stock)).map(h => h.weightPct), [50, 50]);
});

test("cap weights normalize selected companies only and reject missing or nonpositive values", () => {
  const caps = { NVDA: { floatAdjustedMarketCap: 300 }, TSM: { floatAdjustedMarketCap: 100 }, AAPL: { floatAdjustedMarketCap: 999 } };
  assert.deepEqual(allocate([stock("NVDA"), stock("TSM")], "float-cap", caps).map(h => h.weightPct), [75, 25]);
  assert.throws(() => allocate([stock("AMD")], "float-cap", caps));
  assert.throws(() => allocate([stock("NVDA")], "float-cap", { NVDA: { floatAdjustedMarketCap: 0 } }));
  assert.throws(() => allocate([stock("NVDA"), stock("NVDA")]));
});

test("cap import requires recent, same-date, sourced USD values", () => {
  const now = Date.parse("2026-10-10T20:00:00Z");
  const row = { symbol: "NVDA", floatAdjustedMarketCap: 300, currency: "USD", asOf: "2026-10-09", source: "https://example.com/caps" };
  assert.equal(validateCaps([row], now).NVDA.floatAdjustedMarketCap, 300);
  for (const change of [{ asOf: "2026-01-01" }, { asOf: "2026-11-01" }, { currency: "EUR" }, { source: "javascript:alert(1)" }, { floatAdjustedMarketCap: null }]) assert.throws(() => validateCaps([{ ...row, ...change }], now));
  assert.throws(() => validateCaps([row, row], now));
  assert.throws(() => validateCaps([row, { ...row, symbol: "AMD", asOf: "2026-10-06" }], now));
});

test("history uses the real US close across DST and never samples future odds", () => {
  assert.equal(closeTimestamp("2026-07-01"), Date.parse("2026-07-01T20:00:00Z") / 1000);
  assert.equal(closeTimestamp("2026-01-02"), Date.parse("2026-01-02T21:00:00Z") / 1000);
  const prices = [{ date: "2026-07-01", close: 100 }, { date: "2026-07-02", close: 101 }];
  const benchmark = prices.map(p => ({ ...p, close: 100 }));
  const history = [
    { timestamp: closeTimestamp("2026-07-01") - 100, price: 0.4 },
    { timestamp: closeTimestamp("2026-07-02") - 100, price: 0.5 },
    { timestamp: closeTimestamp("2026-07-02") + 100, price: 0.9 },
  ];
  const rows = alignHistory(prices, benchmark, history);
  assert.equal(rows.length, 1);
  assert.ok(Math.abs(rows[0].x - 0.1) < 1e-10);
  assert.equal(alignHistory(prices, benchmark, history.slice(0, 1)).length, 0);
});

function knownData(n = 200) {
  return Array.from({ length: n }, (_, i) => ({
    date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10),
    x: Math.sin(i * 2.17) * 0.03, z: Math.cos(i * 1.39) * 0.01,
    y: 0.5 * Math.sin(i * 2.17) * 0.03 + 1.2 * Math.cos(i * 1.39) * 0.01 + Math.sin(i * 0.77) * 0.002,
  }));
}
test("regression recovers a known odds slope while controlling for SPY", () => {
  const fit = fitAssociation(knownData());
  assert.ok(Math.abs(fit.slope - 0.5) < 0.01);
  assert.ok(fit.se > 0);
  assert.ok(fit.partialR2 > 0.9 && fit.partialR2 <= 1);
  assert.equal(fit.n, 200);
  assert.equal(fitAssociation(knownData(59)), null);
  assert.equal(fitAssociation(knownData().map(r => ({ ...r, x: 0 }))), null);
});

test("the real chronological split flags an association whose direction reverses", () => {
  const prices = [], benchmark = [], history = [];
  let stockPrice = 100, spyPrice = 100, probability = 0.5;
  const days = [];
  for (let offset = 0; days.length < 201; offset++) {
    const day = new Date(Date.UTC(2025, 0, 1 + offset));
    if (![0, 6].includes(day.getUTCDay())) days.push(day.toISOString().slice(0, 10));
  }
  days.forEach((date, i) => {
    const x = Math.sin(i * 2.17) * 0.02, z = Math.cos(i * 1.39) * 0.005;
    probability += x;
    stockPrice *= 1 + (i < 160 ? 0.5 : -0.5) * x + 1.2 * z + Math.sin(i * 0.77) * 0.001;
    spyPrice *= 1 + z;
    prices.push({ date, close: stockPrice }); benchmark.push({ date, close: spyPrice });
    history.push({ timestamp: closeTimestamp(date) - 60, price: probability });
  });
  const fit = association(prices, benchmark, history);
  assert.equal(fit.n, 200);
  assert.equal(fit.holdout.directionStable, false);
  assert.equal(qualifyAssociations([{ fit }])[0].fit.status, "weak");
});

test("slider units, uncertainty and extrapolation are correct; allocation stays fixed", () => {
  const fit = { status: "weak", slope: 0.2, se: 0.2, maxDailyMove: 0.05 };
  const holdings = allocate(symbols.slice(0, 3).map(stock));
  const before = structuredClone(holdings);
  const result = scenario(fit, 0.2, 0.3);
  assert.ok(Math.abs(result.estimatePct - 2) < 1e-10);
  assert.ok(result.lowPct < 0 && result.highPct > 0);
  assert.equal(result.extrapolated, true);
  assert.equal(scenario(fit, 0.2, 0.2).estimatePct, 0);
  assert.equal(scenario({ status: "insufficient" }, 0.2, 0.3), null);
  assert.throws(() => scenario(fit, 0.2, 1.2));
  assert.deepEqual(holdings, before);
});

test("later-sample failure or multiple-testing uncertainty cannot be called a strong association", () => {
  const events = [
    { fit: { status: "exploratory", n: 200, pValue: 0.001, slope: 0.5, se: 0.01, holdout: { directionStable: false } } },
    { fit: { status: "exploratory", n: 200, pValue: 0.5, slope: 0.5, se: 0.4, holdout: { directionStable: true } } },
  ];
  qualifyAssociations(events);
  assert.deepEqual(events.map(e => e.fit.status), ["weak", "weak"]);
  assert.equal(events[0].fit.qValue, 0.002);
});

test("history follows the Yes outcome index, migrated token fallback, pagination and excludes live prints", async () => {
  const seen = [];
  const fakeFetch = async url => {
    const u = new URL(url); seen.push(u.href);
    let body;
    if (u.pathname === "/public-search") body = { events: [{ slug: "test-event", markets: [{ id: "12", question: "Test event?", active: true, closed: false, volume: 100, outcomes: '["No","Yes"]', outcomePrices: '["0.7","0.3"]', positionIds: ["new-no", "new-yes"], clobTokenIds: '["old-no","old-yes"]' }] }] };
    else if (u.searchParams.get("token_id") === "new-yes") body = { data: [], pagination: { has_more: false } };
    else if (!u.searchParams.get("cursor")) body = { data: [{ timestamp: 100, price: 0.2, resolution_seconds: 43200 }], pagination: { has_more: true, next_cursor: "page2" } };
    else body = { data: [{ timestamp: 200, price: 0.3, resolution_seconds: 43200 }, { timestamp: 210, price: 0.3, resolution_seconds: 0 }], pagination: { has_more: false } };
    return new Response(JSON.stringify(body), { status: 200 });
  };
  const event = await eventHistory({ id: "test", label: "Test", query: "Test", match: "Test event", betas: { NVDA: 9999 } }, fakeFetch);
  assert.equal(event.probability, 0.3);
  assert.equal(event.history.length, 2);
  assert.ok(seen.every(url => !url.includes("new-no") && !url.includes("old-no")));
  assert.equal(event.betas, undefined);
  assert.equal(stockEvents({ stocks: {}, events: [event] }, "NVDA")[0].fit.status, "insufficient");
});

test("local server serves preview, starts with no selected holdings and does not expose a weights route", async () => {
  const server = (await createExperimentServer({ snapshot: { stocks: {}, events: [], builtAt: null } })).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const response = await fetch(`${base}/api/stocks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idea: "chips", mode: "preview" }) });
    const body = await response.json();
    assert.equal(body.stocks.length, 10);
    assert.equal(body.holdings, undefined);
    assert.equal((await fetch(`${base}/api/weights`, { method: "POST" })).status, 404);
    assert.equal((await fetch(`${base}/api/events?symbol=BAD`)).status, 400);
    assert.equal((await fetch(`${base}/api/stocks`, { method: "POST", headers: { Origin: "https://example.com" }, body: '{}' })).status, 403);
  } finally { server.close(); }
});
