// The browser adapter (js/stock-api.js) and the local server (backend/server.js), offline.
import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { AgentError, ClarifyError } from "../agent/gemini.js";
import { createApp } from "../backend/server.js";
import { createFindStocks } from "../js/stock-api.js";

const selection = {
  summary: "Your AI chips basket",
  stocks: [{ symbol: "NVDA", name: "NVIDIA" }, { symbol: "TSM", name: "Taiwan Semiconductor" }, { symbol: "AMD", name: "Advanced Micro Devices" }]
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("adapter: posts { idea }, forwards the signal and sends a session id", async () => {
  const seen = [];
  const findStocks = createFindStocks({
    baseUrl: "https://api.example/",
    sessionId: () => "tab-1",
    fetch: async (url, init) => { seen.push({ url, init }); return json(selection); }
  });
  const controller = new AbortController();
  assert.deepEqual(await findStocks({ idea: "AI chips" }, { signal: controller.signal }), selection);
  assert.equal(seen[0].url, "https://api.example/api/stocks");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.body, JSON.stringify({ idea: "AI chips" }));
  assert.equal(seen[0].init.signal, controller.signal);
  assert.equal(seen[0].init.headers["X-Session-Id"], "tab-1");
});

test("adapter: keeps one session id per tab", async () => {
  const ids = [];
  const findStocks = createFindStocks({ baseUrl: "https://api.example", fetch: async (_, init) => { ids.push(init.headers["X-Session-Id"]); return json(selection); } });
  await findStocks({ idea: "a" });
  await findStocks({ idea: "b" });
  assert.equal(ids[0], ids[1]);
  assert.match(ids[0], /^[A-Za-z0-9_.:-]{1,64}$/);
});

test("adapter: rejects on non-2xx, invalid JSON and malformed bodies; never substitutes companies", async () => {
  const withResponse = response => createFindStocks({ baseUrl: "https://api.example", fetch: async () => response() });
  await assert.rejects(withResponse(() => json({ error: { message: "No Gemini model is available right now." } }, 503))({ idea: "x" }), /No Gemini model/);
  await assert.rejects(withResponse(() => new Response("oops", { status: 500 }))({ idea: "x" }), /500/);
  await assert.rejects(withResponse(() => new Response("<html>", { status: 200 }))({ idea: "x" }));
  await assert.rejects(withResponse(() => json({ stocks: [] }))({ idea: "x" }), /invalid response/);
  await assert.rejects(createFindStocks({ baseUrl: "https://api.example", fetch: async () => { throw new TypeError("network down"); } })({ idea: "x" }), /network down/);
});

test("adapter: says so when js/config.js has no API_BASE_URL yet", async () => {
  const { API_BASE_URL } = await import("../js/config.js");
  if (API_BASE_URL) return; // Kieran has filled it in.
  await assert.rejects(createFindStocks({ fetch: async () => json(selection) })({ idea: "x" }), /API_BASE_URL/);
});

async function withServer(deps, run) {
  const server = createApp(deps).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    await run(`http://127.0.0.1:${server.address().port}`);
  } finally {
    server.close();
  }
}
const post = (url, body, headers = {}) =>
  fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: typeof body === "string" ? body : JSON.stringify(body) });

test("server: POST /api/stocks returns the agent's answer and passes the session id on", async () => {
  const calls = [];
  await withServer({ findStocks: async (input, options) => { calls.push({ input, sessionId: options.sessionId, basket: options.basket }); return selection; } }, async base => {
    const response = await post(`${base}/api/stocks`, { idea: "AI chips" }, { "X-Session-Id": "tab-9", Origin: "http://localhost:8000" });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), selection);
    assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:8000");
    assert.deepEqual(calls, [{ input: { idea: "AI chips" }, sessionId: "tab-9", basket: false }]);
  });
});

test("server: CORS only for the website origins, and the session header is allowed", async () => {
  await withServer({ findStocks: async () => selection }, async base => {
    for (const origin of ["https://becomingwise.github.io", "http://localhost:8000", "http://127.0.0.1:8000"]) {
      const preflight = await fetch(`${base}/api/stocks`, { method: "OPTIONS", headers: { Origin: origin } });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get("access-control-allow-origin"), origin);
      assert.match(preflight.headers.get("access-control-allow-headers"), /X-Session-Id/);
    }
    const other = await fetch(`${base}/api/stocks`, { method: "OPTIONS", headers: { Origin: "https://evil.example" } });
    assert.equal(other.headers.get("access-control-allow-origin"), null);
  });
});

test("server: errors are JSON with the agent's status; bad input is 400", async () => {
  await withServer({ findStocks: async () => { throw new AgentError("gemini_unavailable", "No Gemini model is available right now.", 503); } }, async base => {
    const failed = await post(`${base}/api/stocks`, { idea: "AI chips" });
    assert.equal(failed.status, 503);
    assert.equal((await failed.json()).error.code, "gemini_unavailable");
    assert.equal((await post(`${base}/api/stocks`, "not json")).status, 400);
    assert.equal((await fetch(`${base}/api/stocks`)).status, 405);
    assert.equal((await post(`${base}/api/unknown`, {})).status, 404);
  });
});

test("server: POST /api/weights is forwarded unchanged to the live endpoint", async () => {
  const forwarded = [];
  const upstream = { status: "unchanged", holdings: [], explanation: "x", evidence: [] };
  // Only the upstream call is replaced; the test's own requests use the real fetch.
  const fetchFn = async (url, init) => { forwarded.push({ url, body: init.body }); return json(upstream); };
  await withServer({ findStocks: async () => selection, fetch: fetchFn }, async base => {
    const body = { idea: "AI chips", holdings: [{ symbol: "NVDA", weightPct: 100 }] };
    const response = await post(`${base}/api/weights`, body);
    assert.deepEqual(await response.json(), upstream);
    assert.deepEqual(forwarded, [{ url: "https://prophetf.vercel.app/api/weights", body: JSON.stringify(body) }]);
  });
});

const question = { code: "needs_clarification", message: "We don't cover carmakers yet. Which angle fits?", options: ["Chips inside electric cars", "Oil prices and gas stations", "Car loans and banks"] };

test("adapter: a clarification rejects with an Error that keeps code and options", async () => {
  const findStocks = createFindStocks({ baseUrl: "https://api.example", fetch: async () => json({ error: question }, 422) });
  const error = await findStocks({ idea: "car" }).then(() => assert.fail("expected a rejection"), caught => caught);
  assert.ok(error instanceof Error);
  assert.equal(error.message, question.message);
  assert.equal(error.code, "needs_clarification");
  assert.deepEqual(error.options, question.options);

  // Other failures keep their code and have no options.
  const down = createFindStocks({ baseUrl: "https://api.example", fetch: async () => json({ error: { code: "gemini_unavailable", message: "No Gemini model is available right now." } }, 503) });
  const failed = await down({ idea: "AI chips" }).catch(caught => caught);
  assert.equal(failed.code, "gemini_unavailable");
  assert.equal("options" in failed, false);
  const plain = createFindStocks({ baseUrl: "https://api.example", fetch: async () => new Response("oops", { status: 500 }) });
  assert.equal("code" in (await plain({ idea: "x" }).catch(caught => caught)), false);
});

test("server: a clarification is 422 needs_clarification with the options", async () => {
  await withServer({ findStocks: async () => { throw new ClarifyError(question.message, question.options); } }, async base => {
    const response = await post(`${base}/api/stocks`, { idea: "car" });
    assert.equal(response.status, 422);
    assert.deepEqual(await response.json(), { error: question });
  });
});
