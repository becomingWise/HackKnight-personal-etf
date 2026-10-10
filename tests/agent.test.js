// The stock agent with Gemini mocked: no network, no key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AgentError, MAX_MODEL_CALLS, createFindStocks, modelChains, tidySummary } from "../agent/gemini.js";
import { createMemoryStore } from "../agent/memory.js";
import { ALLOWED, retrieve } from "../agent/retrieval.js";
import { checkSignalIds, oddsLine, oddsMoved, reuseCached, usableSignals } from "../agent/signals.js";
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

test("an identical idea is answered from the cache for 15 minutes, across sessions without preferences", async () => {
  let clock = 1_000_000;
  const model = gemini(answer());
  const findStocks = agent(model, { now: () => clock });
  const reports = [];
  const report = detail => reports.push(detail);
  const first = await findStocks({ idea: "AI chips and Taiwan risk" }, { sessionId: "a", report });
  assert.deepEqual(await findStocks({ idea: "  ai chips and taiwan risk. " }, { sessionId: "a", report }), first);
  // Another session, and no session at all, share the entry: nobody has a saved preference.
  assert.deepEqual(await findStocks({ idea: "AI chips and Taiwan risk" }, { sessionId: "b", report }), first);
  assert.deepEqual(await findStocks({ idea: "AI chips and Taiwan risk" }, { report }), first);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(reports.map(detail => detail.reused), [false, true, true, true]);
  assert.deepEqual(reports[0], { reused: false, calls: 1, oddsMoved: null });
  clock += 15 * 60 * 1000 + 1;
  await findStocks({ idea: "AI chips and Taiwan risk" }, { sessionId: "a" });
  assert.equal(model.requests.length, 2);
});

test("a session with a saved preference has its own cache entries", async () => {
  const model = gemini(answer());
  const memory = createMemoryStore();
  const findStocks = agent(model, { memory });
  await memory.rememberPreference("picky", "no oil companies");
  await findStocks({ idea: "AI chips" }, { sessionId: "open" });
  // The shared answer was made without the preference, so it is not served to this session.
  await findStocks({ idea: "AI chips" }, { sessionId: "picky" });
  assert.equal(model.requests.length, 2);
  await findStocks({ idea: "AI chips" }, { sessionId: "picky" });
  await findStocks({ idea: "AI chips" }, { sessionId: "open" });
  assert.equal(model.requests.length, 2);
  // And its answers are never shared with others.
  await findStocks({ idea: "Clean energy" }, { sessionId: "picky" });
  await findStocks({ idea: "Clean energy" }, { sessionId: "open" });
  assert.equal(model.requests.length, 4);
});

test("a preference stated in the request does not cost a second call on the repeat", async () => {
  const model = gemini(toolCall("remember_preference", { preference: "no oil companies" }), answer());
  const findStocks = agent(model);
  const idea = "I never want oil companies. AI chips please";
  const first = await findStocks({ idea }, { sessionId: "a" });
  assert.equal(model.requests.length, 2);
  assert.deepEqual(await findStocks({ idea }, { sessionId: "a" }), first);
  assert.equal(model.requests.length, 2);
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

// ---------- Live Polymarket signals (agent/signals.js) ----------

const SIGNALS = [
  { id: "taiwan", label: "China invades Taiwan", status: "live", price: 0.08, question: "Will China invade Taiwan by end of 2026?", changes: { "1w": -0.02 }, betas: { TSM: -1.0, NVDA: -0.5, AMD: -0.5, LMT: 0.6 } },
  { id: "chip_export_law", label: "AI-chip export licensing becomes law", status: "live", price: 0.31, question: "AI-chip export licensing becomes law?", changes: { "1w": 0.04 }, betas: { NVDA: -0.6, AMD: -0.5 } },
  { id: "openai_1t", label: "OpenAI IPOs above $1T", status: "live", price: 0.2, question: "OpenAI IPO above $1T?", changes: { "1w": null }, betas: { MSFT: 0.4, NVDA: 0.3, AMD: 0.2 } },
  { id: "btc_100k", label: "Bitcoin reaches $100k in 2026", status: "live", price: 0.5, question: "Bitcoin $100k?", changes: { "1w": 0 }, betas: { IBIT: 0.9, COIN: 0.8 } },
  { id: "recession", label: "US recession by end of 2026", status: "unavailable", price: null, betas: { TLT: 0.7 } }
];
const withSignals = (ids, symbols) => text({ summary: "Your AI chips basket", symbols: symbols ?? ["NVDA", "TSM", "AMD"], signals: ids });

test("signals: one compact line per live signal goes into the prompt, with the rule", async () => {
  const model = gemini(answer());
  await agent(model)({ idea: "AI chips and Taiwan risk" }, { signals: SIGNALS });
  const { body } = model.requests[0];
  const prompt = body.contents[0].parts[0].text;
  assert.match(prompt, /LIVE POLYMARKET EVENTS/);
  assert.ok(prompt.includes('- taiwan: "Will China invade Taiwan by end of 2026?" Yes 8%, 7-day change -2 pts. β: TSM -1, LMT +0.6, NVDA -0.5, AMD -0.5'));
  assert.ok(prompt.includes("Yes 31%, 7-day change +4 pts. β: NVDA -0.6, AMD -0.5"));
  assert.ok(prompt.includes("7-day change unknown"));
  assert.match(prompt, /must fit the idea first/);
  assert.match(prompt, /largest \|β\|/);
  // Only live signals are shown, and only they can be named.
  assert.ok(!prompt.includes("recession:"));
  assert.deepEqual(body.generationConfig.responseJsonSchema.properties.signals.items.enum, ["taiwan", "chip_export_law", "openai_1t", "btc_100k"]);
  assert.deepEqual(body.generationConfig.responseJsonSchema.required, ["summary", "symbols"]);
});

test("signals: unknown ids and ids with no β on a picked ticker are dropped", () => {
  const live = usableSignals(SIGNALS);
  const stocks = [{ symbol: "NVDA" }, { symbol: "TSM" }, { symbol: "AMD" }];
  // btc_100k has no β on any of the three; "made_up" and "recession" are not live signals.
  assert.deepEqual(checkSignalIds(["btc_100k", "made_up", "recession", "openai_1t", "taiwan", "taiwan", 7], stocks, live), ["taiwan", "openai_1t"]);
  assert.deepEqual(checkSignalIds(["taiwan"], [{ symbol: "JPM" }, { symbol: "BAC" }, { symbol: "GS" }], live), []);
  assert.deepEqual(checkSignalIds("taiwan", stocks, live), []);
  assert.deepEqual(checkSignalIds(undefined, stocks, live), []);
});

test("signals: the odds line is built from live data, at most two markets, and the response keeps its shape", async () => {
  const model = gemini(withSignals(["openai_1t", "btc_100k", "made_up", "chip_export_law", "taiwan"]));
  const result = await agent(model)({ idea: "AI chips and Taiwan risk" }, { signals: SIGNALS, basket: true });
  // Strongest link to the picked tickers first: taiwan (TSM -1), then chip_export_law (NVDA -0.6).
  assert.equal(result.summary, "Your AI chips basket Live Polymarket odds: China invades Taiwan 8% (▼2 pts this week), AI-chip export licensing becomes law 31% (▲4 pts this week).");
  assert.deepEqual(Object.keys(result).sort(), ["basket", "stocks", "summary"]);
  assert.deepEqual(result.stocks.map(stock => Object.keys(stock).sort()), Array(3).fill(["name", "symbol"]));
  assert.equal(result.basket.title, "Your AI chips basket");

  assert.equal(oddsLine(["openai_1t", "btc_100k"], usableSignals(SIGNALS)), "Live Polymarket odds: OpenAI IPOs above $1T 20%, Bitcoin reaches $100k in 2026 50% (flat this week).");
  assert.equal(oddsLine(["taiwan"], usableSignals([{ ...SIGNALS[0], price: 0.004, changes: { "1w": 0.01 } }])), "Live Polymarket odds: China invades Taiwan <1% (▲1 pt this week).");
  assert.equal(oddsLine(["taiwan"], []), "");
  assert.equal(oddsLine(undefined, usableSignals(SIGNALS)), "");
});

test("signals: Gemini cannot write the odds; a pick that names no signal gets no line", async () => {
  const lying = gemini(text({ summary: "Taiwan invasion odds are 99% today", symbols: ["NVDA", "TSM", "AMD"], signals: [] }));
  assert.equal((await agent(lying)({ idea: "AI chips" }, { signals: SIGNALS })).summary, "Taiwan invasion odds are 99% today");
  const unrelated = gemini(withSignals(["btc_100k"]));
  assert.equal((await agent(unrelated)({ idea: "AI chips" }, { signals: SIGNALS })).summary, "Your AI chips basket");
});

test("signals: a cached answer is served with the odds of that moment", async () => {
  const model = gemini(withSignals(["taiwan"]));
  const findStocks = agent(model);
  await findStocks({ idea: "AI chips and Taiwan risk" }, { signals: SIGNALS });
  const later = [{ ...SIGNALS[0], price: 0.09, changes: { "1w": -0.01 } }];
  const again = await findStocks({ idea: "AI chips and Taiwan risk" }, { signals: later });
  assert.equal(again.summary, "Your AI chips basket Live Polymarket odds: China invades Taiwan 9% (▼1 pt this week).");
  // Without live signals the same cached answer is the plain one.
  assert.deepEqual(await findStocks({ idea: "AI chips and Taiwan risk" }), { summary: "Your AI chips basket", stocks: again.stocks });
  assert.equal(model.requests.length, 1);
});

test("signals: missing or failed signals behave exactly as before", async () => {
  const plain = gemini(answer());
  const expected = await agent(plain)({ idea: "AI chips and Taiwan risk" });
  const dead = SIGNALS.map(signal => ({ ...signal, status: "unavailable", price: null }));
  for (const signals of [undefined, null, [], "oops", dead, [{ id: "taiwan" }, null, { id: "x", price: 0.5 }]]) {
    const model = gemini(answer());
    assert.deepEqual(await agent(model)({ idea: "AI chips and Taiwan risk" }, { signals }), expected);
    assert.deepEqual(model.requests[0], plain.requests[0]);
  }
  assert.ok(!("signals" in plain.requests[0].body.generationConfig.responseJsonSchema.properties));
  assert.deepEqual(usableSignals(dead), []);
});

// ---------- Gemini thinks again only when the odds move ----------

const taiwanAt = price => [{ ...SIGNALS[0], price }, ...SIGNALS.slice(1)];
const HOUR = 3600_000;

test("reuse: an answer that cites a market is reused while its odds moved less than 3 points", async () => {
  let clock = 1_000_000;
  const model = gemini(withSignals(["taiwan"]));
  const findStocks = agent(model, { now: () => clock });
  const reports = [];
  const ask = signals => findStocks({ idea: "AI chips and Taiwan risk" }, { signals, report: detail => reports.push(detail) });

  await ask(taiwanAt(0.08));
  clock += 5 * HOUR; // far beyond the 15 minutes of an answer without markets
  const reused = await ask(taiwanAt(0.105));
  assert.equal(model.requests.length, 1);
  assert.match(reused.summary, /China invades Taiwan 11%/);
  assert.deepEqual(reports[1], { reused: true, calls: 0, oddsMoved: 2.5 });

  // 3 points or more: Gemini decides again, and the new odds become the reference.
  clock += HOUR;
  await ask(taiwanAt(0.11));
  assert.equal(model.requests.length, 2);
  assert.deepEqual(reports[2], { reused: false, calls: 1, oddsMoved: 3 });
  await ask(taiwanAt(0.13));
  assert.equal(model.requests.length, 2);
  assert.equal(reports[3].oddsMoved, 2);
  // A fall counts like a rise.
  await ask(taiwanAt(0.07));
  assert.equal(model.requests.length, 3);
  assert.equal(reports[4].oddsMoved, 4);
});

test("reuse: 24 hours is the limit even when the odds never move", async () => {
  let clock = 1_000_000;
  const model = gemini(withSignals(["taiwan"]));
  const findStocks = agent(model, { now: () => clock });
  const ask = () => findStocks({ idea: "AI chips and Taiwan risk" }, { signals: SIGNALS });
  await ask();
  clock += 24 * HOUR - 1000;
  await ask();
  assert.equal(model.requests.length, 1);
  clock += 2000;
  await ask();
  assert.equal(model.requests.length, 2);
});

test("reuse: an answer with no cited market, or odds that cannot be compared, keeps the 15 minutes", async () => {
  let clock = 1_000_000;
  const plain = gemini(withSignals([]));
  const noMarket = agent(plain, { now: () => clock });
  await noMarket({ idea: "AI chips" }, { signals: SIGNALS });
  clock += 14 * 60_000;
  await noMarket({ idea: "AI chips" }, { signals: taiwanAt(0.5) });
  assert.equal(plain.requests.length, 1);
  clock += 2 * 60_000;
  await noMarket({ idea: "AI chips" }, { signals: SIGNALS });
  assert.equal(plain.requests.length, 2);

  // Cited, but Polymarket cannot be read when serving: reused for 15 minutes only.
  clock = 1_000_000;
  const model = gemini(withSignals(["taiwan"]));
  const findStocks = agent(model, { now: () => clock });
  const reports = [];
  await findStocks({ idea: "Taiwan risk" }, { signals: SIGNALS });
  clock += 14 * 60_000;
  await findStocks({ idea: "Taiwan risk" }, { report: detail => reports.push(detail) });
  assert.equal(model.requests.length, 1);
  assert.deepEqual(reports[0], { reused: true, calls: 0, oddsMoved: null });
  clock += 2 * 60_000;
  await findStocks({ idea: "Taiwan risk" });
  assert.equal(model.requests.length, 2);
});

test("reuse: the rule itself", () => {
  const live = usableSignals(taiwanAt(0.11));
  const limits = { plainTtlMs: 15 * 60_000, citedTtlMs: 24 * HOUR };
  assert.equal(oddsMoved({ taiwan: 0.08 }, live), 3);
  assert.equal(oddsMoved({ taiwan: 0.08, chip_export_law: 0.3 }, live), 3);
  assert.equal(oddsMoved({ taiwan: 0.08, gone: 0.5 }, live), null);
  assert.equal(oddsMoved({}, live), null);
  assert.equal(oddsMoved(undefined, live), null);
  assert.deepEqual(reuseCached({ odds: { taiwan: 0.0801 }, at: 0 }, live, HOUR, limits), { reuse: true, moved: 2.99 });
  assert.deepEqual(reuseCached({ odds: { taiwan: 0.08 }, at: 0 }, live, HOUR, limits), { reuse: false, moved: 3 });
  assert.deepEqual(reuseCached({ odds: { taiwan: 0.11 }, at: 0 }, live, 25 * HOUR, limits), { reuse: false, moved: 0 });
  assert.deepEqual(reuseCached({ at: 0 }, live, HOUR, limits), { reuse: false, moved: null });
  // An entry written before this rule existed has no time: its own expiry decides.
  assert.deepEqual(reuseCached({ summary: "x" }, live, HOUR, limits), { reuse: true, moved: null });
});
