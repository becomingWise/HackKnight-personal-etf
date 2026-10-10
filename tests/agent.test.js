// The stock agent with Gemini mocked: no network, no key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AgentError, MAX_MODEL_CALLS, createFindStocks, modelChains, tidySummary } from "../agent/gemini.js";
import { createMemoryStore } from "../agent/memory.js";
import { ALLOWED, retrieve } from "../agent/retrieval.js";
import { checkSelection, executeTool } from "../agent/tools.js";

const text = value => ({ candidates: [{ content: { role: "model", parts: [{ text: JSON.stringify(value) }] } }] });
const toolCall = (name, args, id = "call_1") => ({
  candidates: [{ content: { role: "model", parts: [{ functionCall: { name, args, id }, thoughtSignature: "sig-1" }] } }]
});
const failure = status => Object.assign(new Error(`HTTP ${status}`), { status });

/** A Gemini stand-in that plays back the given steps (the last one repeats) and records every request. */
function gemini(...steps) {
  const requests = [];
  const callModel = async request => {
    requests.push(structuredClone({ model: request.model, body: request.body }));
    const step = steps[Math.min(requests.length - 1, steps.length - 1)];
    if (step instanceof Error) throw step;
    return typeof step === "function" ? step(request) : step;
  };
  return { callModel, requests };
}
const agent = (model, extra = {}) =>
  createFindStocks({ callModel: model.callModel, memory: createMemoryStore(), sessionId: null, ...extra });
const answer = (symbols = ["NVDA", "TSM", "AMD"], summary = "Your AI chips basket") => text({ summary, symbols });

test("returns exactly three allowed, unique stocks and nothing else", async () => {
  const model = gemini(toolCall("check_selection", { symbols: ["NVDA", "TSM", "AMD"] }), answer());
  const result = await agent(model)({ idea: "AI chips and Taiwan risk" });

  assert.deepEqual(Object.keys(result).sort(), ["stocks", "summary"]);
  assert.equal(result.stocks.length, 3);
  assert.equal(new Set(result.stocks.map(stock => stock.symbol)).size, 3);
  const allowed = new Map(ALLOWED.map(ticker => [ticker.symbol, ticker.name]));
  for (const stock of result.stocks) {
    assert.deepEqual(Object.keys(stock).sort(), ["name", "symbol"]);
    assert.equal(stock.name, allowed.get(stock.symbol));
  }
  assert.equal(result.summary, "Your AI chips basket");
});

test("sends every part of a tool turn back, thought signature and call id included", async () => {
  const model = gemini(toolCall("check_selection", { symbols: ["NVDA", "TSM", "AMD"] }), answer());
  await agent(model)({ idea: "AI chips" });

  const [, second] = model.requests;
  assert.equal(model.requests.length, 2);
  assert.deepEqual(second.body.contents[1].parts[0], {
    functionCall: { name: "check_selection", args: { symbols: ["NVDA", "TSM", "AMD"] }, id: "call_1" },
    thoughtSignature: "sig-1"
  });
  const reply = second.body.contents[2].parts[0].functionResponse;
  assert.equal(reply.name, "check_selection");
  assert.equal(reply.id, "call_1");
  assert.equal(reply.response.ok, true);
});

test("asks for structured output and offers the function tools", async () => {
  const model = gemini(answer());
  await agent(model, { sessionId: "s1" })({ idea: "AI chips" });
  const { body } = model.requests[0];
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig.responseJsonSchema.required, ["summary", "symbols"]);
  assert.deepEqual(
    body.tools[0].functionDeclarations.map(tool => tool.name),
    ["check_selection", "get_memory", "remember_preference", "google_search"]
  );
});

test("the optional basket has equal starting weights from the shared controller", async () => {
  const result = await agent(gemini(answer()))({ idea: "AI chips" }, { basket: true });
  assert.deepEqual(result.basket.holdings.map(holding => holding.weightPct), [33.33, 33.33, 33.34]);
  assert.equal(result.basket.allocationMethod, "equal");
  assert.deepEqual(result.stocks.length, 3);
});

test("a wrong answer gets a correction turn, then passes", async () => {
  const model = gemini(answer(["NVDA", "NVDA", "FAKE"]), answer());
  const result = await agent(model)({ idea: "AI chips" });
  assert.equal(model.requests.length, 2);
  assert.match(model.requests[1].body.contents.at(-1).parts[0].text, /rejected/);
  assert.deepEqual(result.stocks.map(stock => stock.symbol), ["NVDA", "TSM", "AMD"]);
});

test("rejects instead of inventing a basket: wrong count, duplicates, unknown tickers", async () => {
  for (const symbols of [["NVDA", "TSM"], ["NVDA", "NVDA", "TSM"], ["NVDA", "TSM", "SOLAR_DEMO"], ["NVDA", "TSM", "AMD", "INTC"]]) {
    const model = gemini(answer(symbols));
    await assert.rejects(agent(model)({ idea: "AI chips" }), error => error instanceof AgentError && error.code === "invalid_selection");
    assert.equal(model.requests.length, MAX_MODEL_CALLS);
  }
});

test("never makes more than four model calls, and the last one cannot ask for a tool", async () => {
  const model = gemini(toolCall("check_selection", { symbols: ["NVDA"] }));
  await assert.rejects(agent(model)({ idea: "AI chips" }), AgentError);
  assert.equal(model.requests.length, MAX_MODEL_CALLS);
  assert.equal(model.requests.at(-1).body.toolConfig.functionCallingConfig.mode, "NONE");
  assert.equal(model.requests[0].body.toolConfig, undefined);
});

test("rejects when Gemini fails, is unavailable, or the idea is missing", async () => {
  await assert.rejects(agent(gemini(failure(401)))({ idea: "AI chips" }), error => error.code === "gemini_failed");
  await assert.rejects(agent(gemini(failure(503)))({ idea: "AI chips" }), error => error.code === "gemini_unavailable" && error.status === 503);
  await assert.rejects(agent(gemini(text("not json at all")))({ idea: "AI chips" }), AgentError);
  for (const idea of [undefined, "", "   ", 7, "x".repeat(501)]) {
    await assert.rejects(agent(gemini(answer()))({ idea }), error => error.code === "invalid_idea" && error.status === 400);
  }
});

test("a rate-limited model is skipped, and not asked again in the same minute", async () => {
  const model = gemini(failure(429), answer(), answer());
  const findStocks = agent(model);
  await findStocks({ idea: "AI chips" });
  await findStocks({ idea: "Banks and lending" });
  assert.deepEqual(model.requests.map(request => request.model), [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.1-flash-lite"
  ]);
});

test("forwards the caller's signal and rejects when it aborts", async () => {
  const controller = new AbortController();
  const callModel = ({ signal }) =>
    new Promise((_, reject) => {
      signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      controller.abort();
    });
  await assert.rejects(createFindStocks({ callModel, sessionId: null })({ idea: "AI chips" }, { signal: controller.signal }));
});

test("identical (session, idea) is answered from the cache for 15 minutes", async () => {
  let clock = 1_000_000;
  const model = gemini(answer());
  const findStocks = agent(model, { now: () => clock });
  const first = await findStocks({ idea: "AI chips and Taiwan risk" }, { sessionId: "a" });
  assert.deepEqual(await findStocks({ idea: "  ai chips and taiwan risk. " }, { sessionId: "a" }), first);
  assert.equal(model.requests.length, 1);
  await findStocks({ idea: "AI chips and Taiwan risk" }, { sessionId: "b" });
  assert.equal(model.requests.length, 2);
  clock += 15 * 60 * 1000 + 1;
  await findStocks({ idea: "AI chips and Taiwan risk" }, { sessionId: "a" });
  assert.equal(model.requests.length, 3);
});

test("memory is per session: preferences and baskets do not leak", async () => {
  const memory = createMemoryStore();
  const model = gemini(
    toolCall("remember_preference", { preference: "No oil companies" }),
    answer(["FSLR", "LMT", "RTX"], "Clean energy without oil"),
    answer(["XOM", "CVX", "COP"], "Your energy basket"),
    answer(["FSLR", "NVDA", "MSFT"], "Your second basket")
  );
  const findStocks = createFindStocks({ callModel: model.callModel, memory });

  await findStocks({ idea: "No oil companies. Energy" }, { sessionId: "alice" });
  await findStocks({ idea: "Energy prices" }, { sessionId: "bob" });
  assert.deepEqual((await memory.load("alice")).preferences, ["No oil companies"]);
  assert.deepEqual((await memory.load("alice")).baskets.map(basket => basket.symbols), [["FSLR", "LMT", "RTX"]]);
  assert.deepEqual((await memory.load("bob")).preferences, []);
  assert.deepEqual((await memory.load("bob")).baskets.map(basket => basket.symbols), [["XOM", "CVX", "COP"]]);

  // Bob's prompt never contained Alice's preference; Alice's next prompt does.
  assert.doesNotMatch(model.requests[2].body.contents[0].parts[0].text, /No oil companies/);
  await findStocks({ idea: "Something new" }, { sessionId: "alice" });
  assert.match(model.requests[3].body.contents[0].parts[0].text, /Saved preferences \(binding\):\n- No oil companies/);
});

test("without a session nothing is remembered and the memory tools are not offered", async () => {
  const memory = createMemoryStore();
  const model = gemini(answer());
  await createFindStocks({ callModel: model.callModel, memory, sessionId: null })({ idea: "AI chips" }, { sessionId: "not a valid id!" });
  assert.deepEqual(model.requests[0].body.tools[0].functionDeclarations.map(tool => tool.name), ["check_selection", "google_search"]);
});

test("google_search runs as a separate grounded call and counts toward the four", async () => {
  const model = gemini(
    toolCall("google_search", { query: "latest chip export rules" }),
    { candidates: [{ content: { parts: [{ text: "New rules were proposed." }] }, groundingMetadata: { groundingChunks: [{ web: { title: "example.com" } }] } }] },
    answer()
  );
  await agent(model)({ idea: "AI chips" });
  assert.equal(model.requests.length, 3);
  assert.deepEqual(model.requests[1].body.tools, [{ googleSearch: {} }]);
  const reply = model.requests[2].body.contents[2].parts[0].functionResponse.response;
  assert.deepEqual(reply, { available: true, answer: "New rules were proposed.", sources: ["example.com"] });
});

test("a failed search is reported to the model, blocked afterwards, and the request still answers", async () => {
  const model = gemini(toolCall("google_search", { query: "news" }), failure(429), answer(), answer());
  const findStocks = agent(model);
  await findStocks({ idea: "AI chips" });
  assert.equal(model.requests[2].body.contents[2].parts[0].functionResponse.response.available, false);
  // The search model is blocked now, so only GEMINI_MODEL-less chains remain: the tool is still
  // offered while another search model is free.
  assert.equal(model.requests.length, 3);
});

test("tools check their arguments", async () => {
  const context = { sessionId: "s", memory: createMemoryStore() };
  assert.equal(checkSelection("NVDA").ok, false);
  assert.equal(checkSelection(["nvda", " tsm ", "AMD"]).ok, true);
  assert.match(checkSelection(["NVDA", "TSM"]).errors[0], /exactly 3/);
  assert.match(checkSelection(["NVDA", "NVDA", "TSM"]).errors[0], /unique/);
  assert.match(checkSelection(["NVDA", "TSM", "ZZZZ"]).errors[0], /Not in the allowed list: ZZZZ/);
  assert.ok((await executeTool("remember_preference", { preference: "" }, context)).error);
  assert.ok((await executeTool("remember_preference", { preference: "x".repeat(201) }, context)).error);
  assert.ok((await executeTool("google_search", {}, context)).error);
  assert.ok((await executeTool("launch_rocket", {}, context)).error);
  assert.deepEqual(await executeTool("get_memory", null, context), { preferences: [], previousBaskets: [] });
});

test("the notes list exactly the 40 tickers of the weighting universe", async () => {
  const universe = JSON.parse(await readFile(new URL("../backend/src/polyslice_api/data/universe.json", import.meta.url), "utf8"));
  const expected = universe.sectors.flatMap(sector => sector.holdings.map(holding => `${holding.symbol}|${holding.name}`));
  assert.equal(ALLOWED.length, 40);
  assert.deepEqual(ALLOWED.map(ticker => `${ticker.symbol}|${ticker.name}`).sort(), expected.sort());
});

test("retrieval ranks the sectors an idea touches first", () => {
  assert.deepEqual(retrieve("AI chips and Taiwan risk").sectors.map(sector => sector.id).slice(0, 2), ["semis", "bigtech"]);
  assert.equal(retrieve("Underwater basket weaving").matched, false);
  assert.equal(retrieve("Underwater basket weaving").sectors.length, 7);
  assert.equal(retrieve("I like Coinbase").sectors[0].id, "crypto");
});

test("summaries are cut to twelve words; model chains keep Flash for search only", () => {
  assert.equal(tidySummary("one two three four five six seven eight nine ten eleven twelve, thirteen").split(" ").length, 12);
  assert.equal(tidySummary("  Your   AI basket "), "Your AI basket");
  assert.deepEqual(modelChains({}).agent, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.deepEqual(modelChains({ GEMINI_MODEL: "gemini-3.8-flash" }).agent, ["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  assert.equal(modelChains({ GEMINI_MODEL: "gemini-3.8-flash" }).search[0], "gemini-3.8-flash");
  assert.equal(modelChains({ GEMINI_MODEL: "gemini-3.1-flash-lite" }).agent[0], "gemini-3.1-flash-lite");
});
