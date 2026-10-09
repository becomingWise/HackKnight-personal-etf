import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateBasket, calculateBasket, applyScenario, equalWeightHoldings } from "../js/portfolio.js";

const assets = JSON.parse(readFileSync(new URL("../data/assets.json", import.meta.url), "utf8"));
const input = () => ({ budget: 1000, holdings: [
  { assetId: "SOLAR_DEMO", weightPct: 50 },
  { assetId: "TECH_DEMO", weightPct: 30 },
  { assetId: "HEALTH_DEMO", weightPct: 20 }
] });
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

test("allocates a $1,000 basket and computes fractional units from mock prices", () => {
  const result = calculateBasket(input(), assets);
  assert.deepEqual(result.holdings.map(holding => holding.dollars), [500, 300, 200]);
  assert.deepEqual(result.holdings.map(holding => holding.units), [5, 6, 10]);
  assert.equal(result.largestWeightPct, 50);
  close(Object.values(result.interestWeights).reduce((a, b) => a + b), 100);
});

test("keeps units fixed in the +10%, 0%, -10% scenario", () => {
  const basket = calculateBasket(input(), assets);
  const scenario = applyScenario(basket, { SOLAR_DEMO: 10, HEALTH_DEMO: -10 });
  close(scenario.scenarioValue, 1030);
  close(scenario.changePct, 3);
  assert.deepEqual(scenario.holdings.map(holding => holding.units), [5, 6, 10]);
  assert.equal(basket.holdings[0].price, 100);
});

test("a zero-change scenario preserves the budget; a total loss cannot go below zero", () => {
  const basket = calculateBasket(input(), assets);
  close(applyScenario(basket).scenarioValue, 1000);
  const changes = Object.fromEntries(basket.holdings.map(holding => [holding.id, -100]));
  assert.equal(applyScenario(basket, changes).scenarioValue, 0);
  assert.equal(applyScenario(basket, changes).changePct, -100);
  for (const change of [-101, NaN, Infinity]) {
    assert.throws(() => applyScenario(basket, { SOLAR_DEMO: change }), /Price changes/);
  }
  assert.throws(() => applyScenario(basket, { UNKNOWN: 10 }), /Unknown scenario/);
});

test("invalid selections, inputs, weights and mock prices cannot produce a basket", () => {
  const cases = [];
  for (const budget of [0, -10, NaN, Infinity]) cases.push({ ...input(), budget });
  cases.push({ ...input(), holdings: input().holdings.slice(0, 2) });
  cases.push({ ...input(), holdings: assets.map(asset => ({ assetId: asset.id, weightPct: 100 / 6 })) });
  const duplicate = input(); duplicate.holdings[2].assetId = "SOLAR_DEMO"; cases.push(duplicate);
  const unknown = input(); unknown.holdings[0].assetId = "UNKNOWN"; cases.push(unknown);
  for (const weight of [0, -1, NaN, Infinity, 40]) {
    const invalid = input(); invalid.holdings[0].weightPct = weight; cases.push(invalid);
  }
  for (const invalid of cases) {
    assert.ok(validateBasket(invalid, assets).length);
    assert.throws(() => calculateBasket(invalid, assets));
  }
  const badPrices = assets.map(asset => ({ ...asset, price: asset.id === "SOLAR_DEMO" ? 0 : asset.price }));
  assert.throws(() => calculateBasket(input(), badPrices), /positive mock price/);
});

test("equal weights and tolerated display rounding still allocate the whole budget", () => {
  for (const count of [3, 4, 5]) {
    const holdings = equalWeightHoldings(assets.slice(0, count).map(asset => asset.id));
    close(holdings.reduce((sum, holding) => sum + holding.weightPct, 0), 100);
    const basket = calculateBasket({ budget: 1234.56, holdings }, assets);
    close(basket.holdings.reduce((sum, holding) => sum + holding.dollars, 0), 1234.56);
  }
  const rounded = input(); rounded.holdings = rounded.holdings.map(holding => ({ ...holding, weightPct: 33.33 }));
  const basket = calculateBasket(rounded, assets);
  close(basket.holdings.reduce((sum, holding) => sum + holding.dollars, 0), 1000);
});
