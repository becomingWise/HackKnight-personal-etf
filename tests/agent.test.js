// The stock agent with Gemini mocked: no network, no key.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AGENT_VERSION, AgentError, ClarifyError, MAX_MODEL_CALLS, checkClarification, createFindStocks, createLocalCache, modelChains, optionIsCovered, tidySummary } from "../agent/gemini.js";
import { FALLBACK_QUESTION, FIXED_EXAMPLES, NONSENSE_QUESTION, SIGNAL_IDEAS, exampleIdeas, looksLikeNonsense } from "../agent/precheck.js";
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
const answer = (symbols = ["NVDA", "TSM", "AMD"], summary = "Your AI chips basket") => text({ clarity: "clear", why: "Maps to the allowed tickers.", summary, symbols });

test("returns exactly three allowed, unique stocks and nothing else", async () => {
  const model = gemini(toolCall("check_selection", { clarity: "clear", symbols: ["NVDA", "TSM", "AMD"] }), answer());
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
  const model = gemini(toolCall("check_selection", { clarity: "clear", symbols: ["NVDA", "TSM", "AMD"] }), answer());
  await agent(model)({ idea: "AI chips" });

  const [, second] = model.requests;
  assert.equal(model.requests.length, 2);
  assert.deepEqual(second.body.contents[1].parts[0], {
    functionCall: { name: "check_selection", args: { clarity: "clear", symbols: ["NVDA", "TSM", "AMD"] }, id: "call_1" },
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
  assert.deepEqual(body.generationConfig.responseJsonSchema.required, ["clarity", "why"]);
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
  const model = gemini(toolCall("check_selection", { clarity: "clear", symbols: ["NVDA"] }));
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
const withSignals = (ids, symbols) => text({ clarity: "clear", why: "Fits.", summary: "Your AI chips basket", symbols: symbols ?? ["NVDA", "TSM", "AMD"], signals: ids });

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
  assert.deepEqual(body.generationConfig.responseJsonSchema.required, ["clarity", "why"]);
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
  const lying = gemini(text({ clarity: "clear", why: "Fits.", summary: "Taiwan invasion odds are 99% today", symbols: ["NVDA", "TSM", "AMD"], signals: [] }));
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

// ---------- Asking instead of answering (agent/precheck.js, ClarifyError) ----------

const clarify = (question = "We don't cover carmakers yet. Which angle fits?", options = ["Chips inside electric cars", "Oil prices and gas stations", "Car loans and banks"], clarity = "not_covered") =>
  text({ clarity, why: "Not something the allowed tickers cover.", symbols: [], question, options });
const rejection = async promise => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected a rejection");
};

test("pre-check: flags only text that is plainly not an idea", () => {
  for (const nonsense of ["???", "!!!", "...", "  -- ", "🙂🙂", "aaaa", "zzz", "ZZZZZ", "1111", "aaa aaa", "asdf", "asdfgh", "qwerty", "QWERTY", "qwer", "zxcvbn", "hjkl", "lkjh", "asdf qwerty", "asdfgh!!"]) {
    assert.equal(looksLikeNonsense(nonsense), true, nonsense);
  }
  for (const idea of [
    // Tickers and the shortest real ideas.
    "TSM", "NVDA", "AMD", "ASML", "GD", "GS", "MS", "AI", "oil", "Taiwan", "banks", "car", "a", "aa", "5G", "2026",
    // Ordinary text, including words made of neighbouring keys.
    "AI chips and Taiwan risk", "hello", "banana dance", "what's the weather?", "we", "power", "type", "wert", "tree",
    // Real words next to a keyboard run: left to the model.
    "asdf oil", "qwerty keyboards",
    // Other languages and scripts are never judged here.
    "我想投资AI芯片", "台湾", "哈哈哈", "石油", "énergie propre", "Öl", "нефть", "半導体"
  ]) {
    assert.equal(looksLikeNonsense(idea), false, idea);
  }
});

test("pre-check: one example idea per tracked signal, biggest 7-day odds move first", async () => {
  const notes = JSON.parse(await readFile(new URL("../backend/src/polyslice_api/data/universe.json", import.meta.url), "utf8"));
  assert.deepEqual(Object.keys(SIGNAL_IDEAS).sort(), notes.signals.map(signal => signal.id).sort());
  assert.equal(Object.keys(SIGNAL_IDEAS).length, 11);
  for (const idea of Object.values(SIGNAL_IDEAS)) assert.equal(looksLikeNonsense(idea), false);

  const live = usableSignals(SIGNALS);
  // chip_export_law moved 4 points, taiwan 2, btc_100k 0, openai_1t unknown.
  assert.deepEqual(exampleIdeas(live), ["AI chip export rules", "AI chips and Taiwan risk", "Big Tech and an OpenAI IPO"]);
  assert.deepEqual(exampleIdeas(usableSignals([{ ...SIGNALS[3], changes: { "1w": -0.2 } }])), ["Bitcoin reaching $100k", "AI chips and Taiwan risk", "Banks if interest rates stay high"]);
  // Signals unavailable: the fixed examples.
  assert.deepEqual(exampleIdeas([]), FIXED_EXAMPLES);
  assert.deepEqual(exampleIdeas(undefined), FIXED_EXAMPLES);
  assert.equal(FIXED_EXAMPLES.length, 3);
});

test("pre-check: nonsense costs no Gemini call, saves nothing and offers examples", async () => {
  const model = gemini(answer());
  const memory = createMemoryStore();
  const findStocks = agent(model, { memory });
  const error = await rejection(findStocks({ idea: "asdfgh" }, { sessionId: "s1", signals: SIGNALS }));
  assert.ok(error instanceof ClarifyError && error instanceof AgentError);
  assert.equal(error.code, "needs_clarification");
  assert.equal(error.status, 422);
  assert.equal(error.message, NONSENSE_QUESTION);
  assert.ok(error.message.split(" ").length <= 20);
  assert.deepEqual(error.options, ["AI chip export rules", "AI chips and Taiwan risk", "Big Tech and an OpenAI IPO"]);
  assert.deepEqual((await rejection(findStocks({ idea: "???" }))).options, FIXED_EXAMPLES);
  assert.equal(model.requests.length, 0);
  assert.deepEqual(await memory.load("s1"), { preferences: [], baskets: [] });
});

test("clarify: the agent may ask; one call, no tool, nothing saved, and the same text again is free", async () => {
  let clock = 1_000_000;
  const model = gemini(clarify());
  const memory = createMemoryStore();
  const reports = [];
  const findStocks = agent(model, { memory, now: () => clock });
  const ask = (idea, sessionId) => rejection(findStocks({ idea }, { sessionId, report: detail => reports.push(detail) }));

  const error = await ask("car", "s1");
  assert.ok(error instanceof ClarifyError);
  assert.deepEqual({ code: error.code, status: error.status, message: error.message, options: error.options }, {
    code: "needs_clarification",
    status: 422,
    message: "We don't cover carmakers yet. Which angle fits?",
    options: ["Chips inside electric cars", "Oil prices and gas stations", "Car loans and banks"]
  });
  assert.equal(model.requests.length, 1);
  assert.deepEqual(await memory.load("s1"), { preferences: [], baskets: [] });

  // The same text again, also from another visitor, is answered from the cache.
  assert.deepEqual((await ask(" Car. ", "s1")).options, error.options);
  assert.deepEqual((await ask("car", "s2")).options, error.options);
  assert.equal(model.requests.length, 1);
  assert.deepEqual(reports, [
    { reused: false, calls: 1, oddsMoved: null },
    { reused: true, calls: 0, oddsMoved: null },
    { reused: true, calls: 0, oddsMoved: null }
  ]);
  clock += 15 * 60 * 1000 + 1;
  await ask("car", "s1");
  assert.equal(model.requests.length, 2);
});

test("clarify: the model judges the idea first, and the prompt says how", async () => {
  const model = gemini(answer());
  await agent(model)({ idea: "AI chips" }, { signals: SIGNALS });
  const { body } = model.requests[0];
  const schema = body.generationConfig.responseJsonSchema;
  assert.deepEqual(schema.properties.clarity.enum, ["clear", "broad", "not_covered", "unclear"]);
  // clarity and why are generated before anything else.
  assert.deepEqual(Object.keys(schema.properties).slice(0, 2), ["clarity", "why"]);
  assert.deepEqual(schema.propertyOrdering, ["clarity", "why", "summary", "symbols", "question", "options", "signals"]);
  assert.deepEqual(schema.required, ["clarity", "why"]);
  // The count of symbols is checked in code, not by the schema.
  assert.equal("minItems" in schema.properties.symbols, false);
  assert.equal("maxItems" in schema.properties.symbols, false);

  const system = body.systemInstruction.parts[0].text;
  for (const rule of ["FIRST judge the idea", 'ONLY "clear" gets a basket', "We don't cover carmakers yet.", "We don't cover pet companies yet.", "Never offer an option about companies we do not cover", "do not search before asking", "at most 20 words", "any language", "STARTER IDEAS"]) {
    assert.ok(system.includes(rule), rule);
  }
  for (const example of ['"car" -> not_covered', '"cat" -> not_covered', '"food" -> broad', '"money" -> broad', '"travel" -> broad', `"I don't know" -> unclear`, '"banana dance" -> unclear', '"hello" -> unclear', `"what's the weather?" -> unclear`,
    '"oil" -> clear', '"banks" -> clear', '"TSM" -> clear', '"AI chips" -> clear', '"Taiwan" -> clear', '"crypto" -> clear', '"defense stocks" -> clear', '"我想投资AI芯片" -> clear']) {
    assert.ok(system.includes(example), example);
  }
  // The check_selection tool asks for the same judgement.
  const check = body.tools[0].functionDeclarations.find(tool => tool.name === "check_selection");
  assert.deepEqual(check.parameters.required, ["clarity", "symbols"]);
  assert.deepEqual(check.parameters.properties.clarity.enum, ["clear", "broad", "not_covered", "unclear"]);

  // The starter ideas for a person with no idea yet: this week's biggest Polymarket moves.
  const prompt = body.contents[0].parts[0].text;
  assert.ok(prompt.includes("STARTER IDEAS (the options to offer a person who has no idea yet)\n- AI chip export rules\n- AI chips and Taiwan risk\n- Big Tech and an OpenAI IPO\n"));
  const offline = gemini(answer());
  await agent(offline)({ idea: "AI chips" });
  assert.ok(offline.requests[0].body.contents[0].parts[0].text.includes(`- ${FIXED_EXAMPLES.join("\n- ")}\n`));
});

test("clarify: the server enforces the clarity; a basket is never returned unless it is clear", async () => {
  // The model says "broad" and still names three stocks: it becomes a question, not a basket.
  for (const clarity of ["broad", "not_covered", "unclear"]) {
    const model = gemini(text({ clarity, why: "Could mean many things.", summary: "Your food basket", symbols: ["AMZN", "GOOGL", "MSFT"], question: "Which part of food do you mean?", options: ["Grocery delivery and big tech", "Farm lending and banks"] }));
    const memory = createMemoryStore();
    const error = await rejection(agent(model, { memory })({ idea: "food" }, { sessionId: "s1" }));
    assert.equal(error.code, "needs_clarification", clarity);
    assert.deepEqual(error.options, ["Grocery delivery and big tech", "Farm lending and banks"]);
    assert.equal(model.requests.length, 1);
    assert.deepEqual(await memory.load("s1"), { preferences: [], baskets: [] });
  }
});

test("clarify: a missing or invalid question falls back to the starter ideas, with no further call", async () => {
  const long = Array.from({ length: 21 }, (_, index) => `w${index + 1}`).join(" ");
  for (const broken of [
    text({ clarity: "broad", why: "Many themes.", symbols: ["AMZN", "GOOGL", "MSFT"] }),
    text({ clarity: "unclear", why: "No idea yet.", question: long, options: ["Oil majors", "Big banks"] }),
    text({ clarity: "broad", why: "Many themes.", question: "Which?", options: ["Only one option"] }),
    text({ clarity: "unclear", why: "Random words.", question: "Which?", options: ["banana dance", "Oil majors"] })
  ]) {
    const model = gemini(broken);
    const error = await rejection(agent(model)({ idea: "banana dance" }, { signals: SIGNALS }));
    assert.equal(error.code, "needs_clarification");
    assert.equal(error.message, FALLBACK_QUESTION);
    assert.ok(error.message.split(" ").length <= 20);
    assert.deepEqual(error.options, ["AI chip export rules", "AI chips and Taiwan risk", "Big Tech and an OpenAI IPO"]);
    assert.equal(model.requests.length, 1);
  }
  // Without live signals the fixed examples are offered.
  const offline = gemini(text({ clarity: "unclear", why: "No idea yet." }));
  assert.deepEqual((await rejection(agent(offline)({ idea: "I don't know" }))).options, FIXED_EXAMPLES);
});

test("clarify: options we cannot build a basket from are dropped", async () => {
  for (const covered of ["Chips inside electric cars", "Oil prices and gas stations", "Car loans and banks", "Big tech travel platforms", "Defense and aerospace contractors", "Crypto and digital money", "Government bonds and interest rates", "AI chip export rules", "Bitcoin reaching $100k", "电动车芯片", "Aktien für Öl"]) {
    assert.equal(optionIsCovered(covered), true, covered);
  }
  for (const uncovered of ["Restaurants and food delivery", "Supermarkets and food retail", "Airlines and airplane manufacturers", "Hotels and booking websites", "Cruise lines and tourism"]) {
    assert.equal(optionIsCovered(uncovered), false, uncovered);
  }
  // Every fixed example idea can be built.
  for (const idea of Object.values(SIGNAL_IDEAS)) assert.equal(optionIsCovered(idea), true, idea);

  // Two good options are kept and the third is dropped.
  const mixed = gemini(clarify("Which area of travel do you mean?", ["Airlines and airplane manufacturers", "Oil prices and jet fuel", "Big Tech travel booking"], "broad"));
  assert.deepEqual((await rejection(agent(mixed)({ idea: "travel" }))).options, ["Oil prices and jet fuel", "Big Tech travel booking"]);
  // Fewer than two left: the starter ideas, under the model's own question.
  const none = gemini(clarify("Which area of travel do you mean?", ["Airlines and airplane manufacturers", "Hotels and booking websites", "Cruise lines and tourism"], "broad"));
  const error = await rejection(agent(none)({ idea: "travel" }));
  assert.equal(error.message, "Which area of travel do you mean?");
  assert.deepEqual(error.options, FIXED_EXAMPLES);
  assert.equal(none.requests.length, 1);
});

test("clarify: check_selection replies \"ask the person instead\" unless the idea is clear, and that sticks", async () => {
  const reply = await executeTool("check_selection", { clarity: "broad", symbols: ["AMZN", "GOOGL", "MSFT"] }, {});
  assert.equal(reply.ok, false);
  assert.equal(reply.ask, true);
  assert.match(reply.errors[0], /do not pick stocks\. Ask the person instead/);
  assert.equal((await executeTool("check_selection", { clarity: "clear", symbols: ["NVDA", "TSM", "AMD"] }, {})).ok, true);
  assert.match((await executeTool("check_selection", { symbols: ["NVDA", "TSM", "AMD"] }, {})).errors[0], /clarity is required/);
  assert.match((await executeTool("check_selection", { clarity: "maybe", symbols: [] }, {})).errors[0], /clarity is required/);

  // The model tells the tool "broad", is told to ask, and then tries a basket anyway.
  const stubborn = gemini(toolCall("check_selection", { clarity: "broad", symbols: ["AMZN", "GOOGL", "MSFT"] }), answer(["AMZN", "GOOGL", "MSFT"], "Your food basket"));
  const error = await rejection(agent(stubborn)({ idea: "food" }));
  assert.equal(error.code, "needs_clarification");
  assert.equal(error.message, FALLBACK_QUESTION);
  assert.deepEqual(error.options, FIXED_EXAMPLES);
  assert.equal(stubborn.requests.length, 2);
  assert.equal(stubborn.requests[1].body.contents[2].parts[0].functionResponse.response.ask, true);

  // The usual path: told to ask, it asks.
  const polite = gemini(toolCall("check_selection", { clarity: "not_covered", symbols: [] }), clarify());
  assert.deepEqual((await rejection(agent(polite)({ idea: "car" }))).options, ["Chips inside electric cars", "Oil prices and gas stations", "Car loans and banks"]);
});

test("clarify: an answer without a clarity gets the usual correction turn", async () => {
  const model = gemini(text({ summary: "Your AI chips basket", symbols: ["NVDA", "TSM", "AMD"] }), answer());
  const result = await agent(model)({ idea: "AI chips" });
  assert.equal(result.stocks.length, 3);
  assert.equal(model.requests.length, 2);
  const correction = model.requests[1].body.contents.at(-1).parts[0].text;
  assert.match(correction, /rejected/);
  assert.match(correction, /clarity is required and must be one of: clear, broad, not_covered, unclear/);
  assert.match(correction, /clarity first/);

  // Four answers without one end in an error, never in an invented basket or question.
  const stubborn = gemini(text({ clarity: "sure", symbols: ["NVDA", "TSM", "AMD"] }));
  const failed = await rejection(agent(stubborn)({ idea: "AI chips" }));
  assert.equal(failed.code, "invalid_selection");
  assert.equal(stubborn.requests.length, MAX_MODEL_CALLS);
});

test("cache: the agent version is part of every key, so new rules start with an empty cache", async () => {
  const keys = [];
  const inner = createLocalCache();
  const cache = {
    get: key => inner.get(key),
    set: (key, value, ttl) => {
      keys.push(key);
      return inner.set(key, value, ttl);
    }
  };
  const memory = createMemoryStore();
  await memory.rememberPreference("picky", "no oil companies");
  const model = gemini(answer());
  const findStocks = agent(model, { cache, memory });
  await findStocks({ idea: "AI chips" });
  await findStocks({ idea: "AI chips" }, { sessionId: "picky" });
  assert.deepEqual(keys, [`v${AGENT_VERSION}|-|ai chips`, `v${AGENT_VERSION}|picky|ai chips`]);

  // An answer stored under the old rules (keys without a version) is never read.
  await inner.set("-|car", { summary: "Old basket", stocks: [{ symbol: "XOM", name: "Exxon Mobil" }] }, 60_000);
  await inner.set("v1|-|car", { summary: "Old basket", stocks: [] }, 60_000);
  const asking = gemini(clarify());
  const error = await rejection(agent(asking, { cache })({ idea: "car" }));
  assert.equal(error.code, "needs_clarification");
  assert.equal(asking.requests.length, 1);
});

test("clarify: a picked option gives a basket, and a basket still needs exactly three symbols", async () => {
  const model = gemini(clarify(), answer(["NVDA", "TSM", "AMD"], "Your electric car chips basket"));
  const findStocks = agent(model);
  const error = await rejection(findStocks({ idea: "car" }));
  const result = await findStocks({ idea: error.options[0] });
  assert.deepEqual(result.stocks.map(stock => stock.symbol), ["NVDA", "TSM", "AMD"]);
  assert.deepEqual(Object.keys(result).sort(), ["stocks", "summary"]);

  // A "clear" answer with a wrong count is corrected like before.
  const short = gemini(text({ clarity: "clear", why: "Fits.", summary: "Two", symbols: ["NVDA", "TSM"] }), text({ clarity: "clear", why: "Fits.", summary: "Three", symbols: ["NVDA", "TSM", "AMD"] }));
  assert.equal((await agent(short)({ idea: "AI chips" })).summary, "Three");
  assert.equal(short.requests.length, 2);
});

test("clarify: the rules for a question and its options", () => {
  const ok = checkClarification("  Which   angle fits? ", ["Chips inside electric cars", " Car loans and banks "], "car");
  assert.deepEqual(ok, { ok: true, clarify: { question: "Which angle fits?", options: ["Chips inside electric cars", "Car loans and banks"] } });
  assert.equal(checkClarification("哪个方向？", ["电动车芯片", "石油和加油站", "车贷和银行"], "车").ok, true);
  const bad = (question, options, idea = "car") => checkClarification(question, options, idea).errors.join(" ");
  assert.match(bad("", ["a b", "c d"]), /needs a question/);
  assert.match(bad("Which?", ["One", "Two", "Three", "Four"]), /you gave 4/);
  assert.match(bad("Which?", ["Same idea", "same idea."]), /different/);
  assert.match(bad("Which?", ["Oil", 7]), /different, non-empty strings/);
  assert.match(bad("Which?", "Oil"), /non-empty strings/);
  assert.match(bad("Which?", ["Oil majors", "x".repeat(101)]), /at most 100 characters/);
  // An option that is the person's own text, or unreadable, would only lead back to the question.
  assert.match(bad("Which?", ["Car", "Car loans and banks"]), /new, complete idea/);
  assert.match(bad("Which?", ["asdf", "Car loans and banks"]), /new, complete idea/);
});

test("clarify: once the agent asks it stops: no search, no further call", async () => {
  // Asked on the second turn, after a tool call: the question still ends the request.
  const model = gemini(toolCall("get_memory", {}), clarify("Which part of food do you mean?", ["Grocery delivery and big tech", "Farm lending and banks"], "broad"));
  const memory = createMemoryStore();
  const error = await rejection(agent(model, { memory })({ idea: "food" }, { sessionId: "s1" }));
  assert.equal(error.code, "needs_clarification");
  assert.equal(model.requests.length, 2);
  assert.ok(model.requests.every(request => !request.body.tools.some(tool => tool.googleSearch)));
  assert.deepEqual(await memory.load("s1"), { preferences: [], baskets: [] });
});
