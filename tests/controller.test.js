import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createController, GREETING, validateAdjustment } from "../js/controller.js";
import { createMockServices } from "../js/services.js";

const fixtures = JSON.parse(readFileSync(new URL("../data/chat-demo.json", import.meta.url), "utf8"));
const selection = () => structuredClone({ summary: fixtures.themes[0].summary, stocks: fixtures.themes[0].stocks });
const unchanged = async ({ holdings }) => ({ status: "unchanged", holdings, explanation: "No relevant markets.", evidence: [] });
const services = overrides => ({ findStocks: async () => selection(), adjustWeights: unchanged, ...overrides });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("chat -> selection -> equal dashboard -> adjustment, with isolated state snapshots", async () => {
  const adjustment = deferred();
  const states = [];
  const controller = createController(services({ adjustWeights: () => adjustment.promise }));
  const unsubscribe = controller.subscribe(state => states.push(state));
  assert.equal(controller.getState().messages[0].content, GREETING);
  const running = controller.submitIdea("  I like AI  ");
  assert.equal(controller.getState().status, "finding");
  await Promise.resolve();
  const baseline = controller.getState();
  assert.equal(baseline.view, "dashboard");
  assert.equal(baseline.status, "adjusting");
  assert.equal(baseline.idea, "I like AI");
  assert.deepEqual(baseline.holdings.map(item => item.weightPct), [33.33, 33.33, 33.34]);
  baseline.holdings[0].weightPct = -100;
  assert.equal(controller.getState().holdings[0].weightPct, 33.33);
  adjustment.resolve({ status: "adjusted", holdings: baseline.startingHoldings.map((item, index) => ({ ...item, weightPct: [50, 30, 20][index] })), explanation: "Sample adjustment.", evidence: [] });
  await running;
  assert.deepEqual(controller.getState().holdings.map(item => item.weightPct), [50, 30, 20]);
  assert.deepEqual(states.map(state => state.status), ["idle", "finding", "adjusting", "ready"]);
  unsubscribe();
  controller.reset();
  assert.equal(states.length, 4);
});

test("blank input makes no calls and duplicate submissions do not create extra requests", async () => {
  let calls = 0;
  const found = deferred();
  const controller = createController(services({ findStocks: () => { calls += 1; return found.promise; } }));
  await controller.submitIdea(" \n ");
  assert.ok(controller.getState().error);
  assert.equal(calls, 0);
  const running = controller.submitIdea("AI");
  await controller.submitIdea("healthcare");
  assert.equal(calls, 1);
  assert.equal(controller.getState().idea, "AI");
  found.resolve(selection());
  await running;
});

test("selection errors retain the idea and allow a successful retry", async () => {
  let calls = 0;
  const controller = createController(services({ findStocks: async () => {
    if (++calls === 1) throw new Error("Service unavailable");
    return selection();
  } }));
  await controller.submitIdea("AI");
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().view, "chat");
  assert.equal(controller.getState().idea, "AI");
  await controller.submitIdea("AI");
  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().error, null);
});

test("malformed stock selections cannot open a dashboard or call the weighting adapter", async () => {
  const responses = [null, { summary: "Empty", stocks: [] }, { summary: "Duplicate", stocks: [selection().stocks[0], selection().stocks[0]] }, { summary: "Missing name", stocks: [{ symbol: "A" }] }];
  for (const response of responses) {
    let calls = 0;
    const controller = createController(services({ findStocks: async () => response, adjustWeights: async () => { calls += 1; } }));
    await controller.submitIdea("AI");
    assert.equal(controller.getState().status, "error");
    assert.equal(controller.getState().view, "chat");
    assert.equal(calls, 0);
  }
});

test("adjustment failures retain baseline percentages and finish in a usable state", async () => {
  const controller = createController(services({ adjustWeights: async () => { throw new Error("Offline"); } }));
  await controller.submitIdea("AI");
  const state = controller.getState();
  assert.equal(state.status, "ready");
  assert.equal(state.adjustment.status, "unavailable");
  assert.deepEqual(state.holdings, state.startingHoldings);
  assert.match(state.adjustment.explanation, /No adjustment was applied/);
});

test("malformed weights, mismatched symbols, and invalid evidence retain baseline", async () => {
  const base = selection().stocks.map(stock => ({ symbol: stock.symbol, weightPct: 100 / 3 }));
  const good = () => ({ status: "adjusted", holdings: structuredClone(base), explanation: "Adjusted.", evidence: [] });
  const cases = [];
  for (const weight of [NaN, Infinity, -1, 101, "33.33", 0]) {
    const response = good(); response.holdings[0].weightPct = weight; cases.push(response);
  }
  const unknown = good(); unknown.holdings[0].symbol = "UNKNOWN"; cases.push(unknown);
  const duplicate = good(); duplicate.holdings[0].symbol = base[1].symbol; cases.push(duplicate);
  const missing = good(); missing.holdings.pop(); cases.push(missing);
  const wrongStatus = good(); wrongStatus.status = "success"; cases.push(wrongStatus);
  const unsafe = good(); unsafe.evidence = [{ title: "Market", url: "javascript:alert(1)", outcome: "Yes", probability: .5, observedAt: "2026-10-09T22:00:00Z" }]; cases.push(unsafe);
  const misleading = good(); misleading.status = "unchanged"; misleading.holdings[0].weightPct = 50; misleading.holdings[1].weightPct = 30; misleading.holdings[2].weightPct = 20; cases.push(misleading);
  for (const response of cases) {
    const controller = createController(services({ adjustWeights: async () => response }));
    await controller.submitIdea("AI");
    assert.equal(controller.getState().adjustment.status, "unavailable");
    assert.deepEqual(controller.getState().holdings, controller.getState().startingHoldings);
  }
});

test("valid reordered and rounded weights are normalized into the selected stock order", () => {
  const baseline = selection().stocks.map(stock => ({ symbol: stock.symbol, weightPct: 100 / 3 }));
  const result = validateAdjustment({ status: "adjusted", holdings: [...baseline].reverse().map(item => ({ ...item, weightPct: 33.33 })), explanation: "Rounded.", evidence: [{ title: "Example market", url: "https://example.com/market", outcome: "Yes", probability: .7, observedAt: "2026-10-09T22:00:00Z" }] }, baseline);
  assert.deepEqual(result.holdings.map(item => item.symbol), baseline.map(item => item.symbol));
  assert.ok(Math.abs(result.holdings.reduce((sum, item) => sum + item.weightPct, 0) - 100) < 1e-8);
});

test("editing preserves the idea; view navigation preserves a completed basket; reset clears it", async () => {
  const controller = createController(services());
  controller.setView("dashboard");
  assert.equal(controller.getState().view, "chat");
  await controller.submitIdea("AI");
  const basket = controller.getState().holdings;
  controller.setView("chat"); controller.setView("dashboard");
  assert.deepEqual(controller.getState().holdings, basket);
  controller.editIdea();
  assert.equal(controller.getState().idea, "AI");
  assert.equal(controller.getState().view, "chat");
  assert.equal(controller.getState().stocks.length, 0);
  controller.reset();
  assert.equal(controller.getState().idea, "");
  assert.equal(controller.getState().messages.length, 1);
});

test("reset cancels the request and ignores late stock responses", async () => {
  const found = deferred();
  let signal, adjustments = 0;
  const controller = createController(services({ findStocks: (_input, options) => { signal = options.signal; return found.promise; }, adjustWeights: async () => { adjustments += 1; } }));
  const running = controller.submitIdea("Old idea");
  controller.reset();
  assert.equal(signal.aborted, true);
  found.resolve(selection());
  await running;
  assert.equal(controller.getState().status, "idle");
  assert.equal(controller.getState().stocks.length, 0);
  assert.equal(adjustments, 0);
});

test("a late adjustment cannot overwrite a new session after reset", async () => {
  const oldAdjustment = deferred();
  let calls = 0;
  const controller = createController(services({ adjustWeights: input => ++calls === 1 ? oldAdjustment.promise : unchanged(input) }));
  const old = controller.submitIdea("Old idea");
  await Promise.resolve();
  controller.reset();
  await controller.submitIdea("New idea");
  oldAdjustment.resolve({ status: "adjusted", holdings: [], explanation: "Late", evidence: [] });
  await old;
  assert.equal(controller.getState().idea, "New idea");
  assert.equal(controller.getState().adjustment.status, "unchanged");
});

test("editing while finding ignores the late response and preserves the editable idea", async () => {
  const found = deferred();
  const controller = createController(services({ findStocks: () => found.promise }));
  const running = controller.submitIdea("Keep this text");
  controller.editIdea();
  found.resolve(selection());
  await running;
  assert.equal(controller.getState().idea, "Keep this text");
  assert.equal(controller.getState().status, "idle");
  assert.equal(controller.getState().stocks.length, 0);
});

test("reset during the dashboard transition cannot start an obsolete weighting request", async () => {
  let calls = 0;
  const controller = createController(services({ adjustWeights: async () => { calls += 1; } }));
  controller.subscribe(state => { if (state.status === "adjusting") controller.reset(); });
  await controller.submitIdea("AI");
  assert.equal(calls, 0);
  assert.equal(controller.getState().status, "idle");
});

test("all three demo themes are deterministic and unsupported languages/ideas are labeled generic", async () => {
  const mock = createMockServices({ loadFixtures: async () => fixtures, wait: async () => {} });
  for (const [idea, keyword] of [["I like AI", "Technology"], ["I care about clean energy", "Clean energy"], ["Healthcare matters", "Healthcare"], ["我关注清洁能源", "Clean energy"]]) {
    const one = await mock.findStocks({ idea });
    assert.deepEqual(one, await mock.findStocks({ idea }));
    assert.match(one.summary, new RegExp(keyword));
    assert.equal(one.stocks.length, 3);
    const controller = createController(mock);
    await controller.submitIdea(idea);
    assert.equal(controller.getState().adjustment.status, "adjusted");
  }
  for (const idea of ["I like sailing", "旅行が好きです", "chair manufacturing"]) {
    const controller = createController(mock);
    await controller.submitIdea(idea);
    assert.match(controller.getState().summary, /Generic example/);
    assert.equal(controller.getState().adjustment.status, "unchanged");
  }
});
