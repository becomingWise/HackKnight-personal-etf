import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createSuggestionService, createSuggestions, previewSuggestions } from "../experiment/suggestions.js";
import { addExplicitPreferences, excludedSymbols, createSessionMemory } from "../experiment/preferences.js";
import { weeklyOddsChange } from "../experiment/evidence.js";
import { restoreAgentSession } from "../experiment/session.js";
import { createExperimentServer } from "../experiment/server.mjs";
import { createFindStocks, createLocalCache } from "../agent/gemini.js";

const symbols = ["NVDA", "TSM", "AVGO", "AMD", "ASML", "MU", "INTC", "MSFT"];
const answer = data => ({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(data) }] } }] });
const clear = { clarity: "clear", why: "Matches chips", summary: "AI chip companies", symbols };

test("main and experiment keep separate selection caches, including changed browser preferences", async () => {
  const cache = createLocalCache(), memory = createSessionMemory();
  const main = createFindStocks({ cache, memory, callModel: async () => answer({ ...clear, symbols: symbols.slice(0, 3) }) });
  let calls = 0;
  const experiment = createSuggestions({ cache, memory, callModel: async () => {
    calls++;
    return answer(calls === 1 ? clear : { ...clear, symbols: [...symbols.slice(1), "AAPL"] });
  } });
  const input = { idea: "AI chips" }, context = { sessionId: "same-browser" };
  assert.equal((await main(input, context)).stocks.length, 3);
  assert.equal((await experiment(input, context)).stocks.length, 8);
  assert.equal((await experiment(input, context)).stocks.length, 8);
  assert.equal(calls, 1);
  await memory.replacePreferences(context.sessionId, ["Exclude NVDA"]);
  const updated = await experiment(input, context);
  assert.equal(updated.stocks.some(s => s.symbol === "NVDA"), false);
  assert.equal(calls, 2, "changed preferences invalidate the experiment's cached answer");
});

test("ambiguous and unsupported example ideas ask rather than fabricate a basket", () => {
  for (const idea of ["asdf", "???", "hello", "food", "car", "banana dance", "no idea"]) {
    assert.throws(() => previewSuggestions({ idea }), err => err.code === "needs_clarification" &&
      err.status === 422 && err.options.length === 3 && err.options.every(option => previewSuggestions({ idea: option }).stocks.length >= 7));
  }
  for (const idea of ["oil", "TSM", "AI chips", "能源", "我想投资AI芯片"]) assert.equal(previewSuggestions({ idea }).stocks.length, 10);
  assert.throws(() => previewSuggestions({ idea: "TLT" }), err => err.code === "needs_clarification" && !/preferences exclude/i.test(err.message));
});

test("live mode judges clarity, including a model that tries to supply stocks for an unclear idea", async () => {
  let calls = 0;
  const find = createSuggestions({ callModel: async () => { calls++; return answer({ ...clear, clarity: "broad", question: "Which theme?", options: ["AI chips", "Oil supply"] }); } });
  await assert.rejects(find({ idea: "food" }), err => err.code === "needs_clarification" && err.message === "Which theme?" && err.options.length === 2);
  assert.equal(calls, 1);
  await assert.rejects(find({ idea: "qwerty" }), err => err.code === "needs_clarification");
  assert.equal(calls, 1, "plain nonsense costs no Gemini call");
});

test("clarity rejection by a tool stays binding even if the final model answer changes its mind", async () => {
  let calls = 0;
  const find = createSuggestions({ callModel: async () => ++calls === 1 ? {
    candidates: [{ content: { role: "model", parts: [{ functionCall: { name: "check_selection", args: { clarity: "unclear", symbols } } }] } }],
  } : answer(clear) });
  await assert.rejects(find({ idea: "ambiguous theme" }), err => err.code === "needs_clarification");
});

test("live mode cannot return main's three-stock basket", async () => {
  const find = createSuggestions({ callModel: async () => answer({ ...clear, symbols: symbols.slice(0, 3) }) });
  await assert.rejects(find({ idea: "AI chips" }), err => ["invalid_selection", "call_limit"].includes(err.code));
});

test("exclusions target companies, sectors and oil businesses without excluding renewable energy", () => {
  assert.deepEqual([...excludedSymbols(["Exclude NVDA"])], ["NVDA"]);
  assert.deepEqual([...excludedSymbols(["Avoid NVIDIA"])], ["NVDA"]);
  const oil = excludedSymbols(["no oil companies"]);
  assert.equal(oil.has("XOM"), true); assert.equal(oil.has("FSLR"), false);
  assert.equal(excludedSymbols(["exclude banks"]).has("JPM"), true);
  assert.equal(excludedSymbols(["不要石油公司"]).has("CVX"), true);
  assert.deepEqual(addExplicitPreferences([], "AI chips, exclude banks"), ["Exclude banks"]);
  assert.deepEqual(addExplicitPreferences([], "no idea"), []);
  assert.deepEqual(addExplicitPreferences([], "exclude banks and invest in energy"), ["Exclude banks"]);
  assert.equal(previewSuggestions({ idea: "exclude banks and invest in energy", preferences: ["Exclude banks"] }).stocks[0].symbol, "XOM");
});

test("preferences survive a browser refresh and a new local server process; removing them changes the result", async () => {
  const first = createSuggestionService();
  const initial = await first({ idea: "energy, exclude banks" }, { sessionId: "person-a" });
  assert.deepEqual(initial.preferences, ["Exclude banks"]);
  const restored = restoreAgentSession(JSON.stringify({ id: "person-a", preferences: initial.preferences, draft: "banks" }));
  assert.equal(restored.id, "person-a");
  const restarted = createSuggestionService();
  await assert.rejects(restarted({ idea: "banks", preferences: restored.preferences }, { sessionId: restored.id }), err =>
    err.code === "needs_clarification" && err.options.every(option => !/banks/i.test(option)));
  const kept = await restarted({ idea: "AI chips", preferences: restored.preferences }, { sessionId: restored.id });
  assert.equal(kept.stocks.some(s => ["JPM", "BAC", "GS", "MS", "SCHW"].includes(s.symbol)), false);
  const removed = await restarted({ idea: "banks", preferences: [] }, { sessionId: restored.id });
  assert.equal(removed.stocks.some(s => s.symbol === "JPM"), true);
  const other = await first({ idea: "banks" }, { sessionId: "person-b" });
  assert.equal(other.preferences.length, 0);
  for (const data of [{ id: "bad id", preferences: [] }, { id: "a", preferences: [null] }, { id: "a", preferences: Array(11).fill("no banks") }])
    assert.equal(restoreAgentSession(JSON.stringify(data)), null);
});

test("excluded stocks are corrected in live mode and the preference reaches the model", async () => {
  const memory = createSessionMemory();
  await memory.replacePreferences("person-a", ["Exclude NVDA"]);
  let calls = 0, prompt;
  const find = createSuggestions({ memory, callModel: async request => {
    calls++; prompt = request.body.contents[0].parts[0].text;
    return answer(calls === 1 ? clear : { ...clear, symbols: [...symbols.slice(1), "AAPL"] });
  } });
  const result = await find({ idea: "AI chips" }, { sessionId: "person-a" });
  assert.equal(result.stocks.some(s => s.symbol === "NVDA"), false);
  assert.equal(calls, 2); assert.match(prompt, /Exclude NVDA/);
});

test("caching reuses successful answers and invalidates on relevant evidence, preferences and expiry", async () => {
  let calls = 0, now = 1000;
  const service = createSuggestionService({ now: () => now, suggest: async () => { calls++; return { stocks: symbols.map(symbol => ({ symbol, name: symbol })), summary: "Chips", source: "gemini" }; } });
  const input = { idea: "AI chips", mode: "gemini", preferences: [] };
  const event = { id: "polymarket:1", provider: "polymarket", marketId: "1", title: "Chip exports?", probability: .4, status: "available", linkedSymbols: ["NVDA"] };
  const context = { sessionId: "person-a", events: [event] };
  assert.equal((await service(input, context)).reused, false);
  assert.equal((await service(input, context)).reused, true); assert.equal(calls, 1);
  await service(input, { ...context, events: [event, { ...event, id: "irrelevant", linkedSymbols: ["JPM"] }] }); assert.equal(calls, 1);
  await service(input, { ...context, events: [{ ...event, probability: .45 }] }); assert.equal(calls, 2);
  await service(input, { ...context, events: [{ ...event, marketId: "new-contract" }] }); assert.equal(calls, 3);
  await service({ ...input, preferences: ["Exclude banks"] }, context); assert.equal(calls, 4);
  now += 15 * 60 * 1000;
  await service({ ...input, preferences: ["Exclude banks"] }, context); assert.equal(calls, 5);
  await service(input, { ...context, sessionId: "person-b" }); assert.equal(calls, 6);
});

test("failed live suggestions never become examples or cached successes, and do not keep new preferences", async () => {
  let calls = 0;
  const memory = createSessionMemory();
  const service = createSuggestionService({ memory, suggest: async () => { calls++; throw new Error("Gemini unavailable"); } });
  const input = { idea: "AI chips, exclude banks", mode: "gemini", preferences: [] };
  for (let i = 0; i < 2; i++) await assert.rejects(service(input, { sessionId: "person-a" }), /Gemini unavailable/);
  assert.equal(calls, 2); assert.deepEqual((await memory.load("person-a")).preferences, []);
});

test("weekly moves use the observed contract's past quote; missing, stale-gap and future history are not invented", () => {
  const now = Date.parse("2026-10-10T20:00:00Z") / 1000, week = 7 * 86400;
  const event = { status: "available", probability: .6, observedAt: new Date(now * 1000).toISOString(), history: [
    { timestamp: now - week - 3600, price: .4 }, { timestamp: now - week + 1, price: .9 }, { timestamp: now + 3600, price: .8 },
  ] };
  assert.ok(Math.abs(weeklyOddsChange(event).change - .2) < 1e-9);
  assert.ok(weeklyOddsChange({ ...event, probability: .2 }).change < 0);
  assert.equal(weeklyOddsChange({ ...event, probability: .4 }).change, 0);
  for (const change of [{ status: "unavailable" }, { observedAt: null }, { probability: null }, { history: [] },
    { history: [{ timestamp: now - week - 86401, price: .4 }] }, { history: [{ timestamp: now - week + 1, price: .4 }] }])
    assert.equal(weeklyOddsChange({ ...event, ...change }), null);
});

test("HTTP clarifications expose choices and retained preferences; example cache remains session-aware", async () => {
  const server = (await createExperimentServer({ snapshot: { stocks: {}, events: [], builtAt: null } })).listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = body => fetch(`${base}/api/stocks`, { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": "browser-a" }, body: JSON.stringify(body) });
  try {
    const clarify = await post({ idea: "hello, exclude banks", preferences: [] });
    assert.equal(clarify.status, 422);
    const problem = (await clarify.json()).error;
    assert.equal(problem.code, "needs_clarification"); assert.equal(problem.options.length, 3);
    assert.deepEqual(problem.preferences, ["Exclude banks"]);
    const request = { idea: problem.options[0], preferences: problem.preferences };
    const result = await post(request); assert.equal(result.headers.get("X-Cache"), "MISS");
    assert.equal((await result.json()).stocks.length, 10);
    assert.equal((await post(request)).headers.get("X-Cache"), "HIT");
    assert.equal((await post({ idea: "AI chips", preferences: [123] })).status, 400);
  } finally { server.close(); }
});
