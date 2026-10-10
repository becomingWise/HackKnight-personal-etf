// The browser adapter for the AI voting panel (js/votes-api.js), offline.
import assert from "node:assert/strict";
import test from "node:test";
import { createGetVotes } from "../js/votes-api.js";

const stocks = [{ symbol: "NVDA", name: "NVIDIA" }, { symbol: "TSM", name: "Taiwan Semiconductor" }, { symbol: "AMD", name: "Advanced Micro Devices" }];
const votes = {
  summary: "1 of 1 stocks backed by a majority",
  stocks: [{ symbol: "NVDA", name: "NVIDIA", yes: 4, no: 1, votes: [{ agent: "Growth investor", vote: "yes", reason: "Strong AI chip demand." }] }]
};
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

test("votes adapter: posts { idea, stocks } and forwards the signal", async () => {
  const seen = [];
  const getVotes = createGetVotes({ baseUrl: "https://api.example/", fetch: async (url, init) => { seen.push({ url, init }); return json(votes); } });
  const controller = new AbortController();
  // Extra fields on a stock (a weight, say) are not sent.
  const input = stocks.map(stock => ({ ...stock, weightPct: 33.33 }));
  assert.deepEqual(await getVotes({ idea: "AI chips", stocks: input }, { signal: controller.signal }), votes);
  assert.equal(seen[0].url, "https://api.example/api/votes");
  assert.equal(seen[0].init.method, "POST");
  assert.equal(seen[0].init.body, JSON.stringify({ idea: "AI chips", stocks }));
  assert.equal(seen[0].init.signal, controller.signal);
});

test("votes adapter: rejects on non-2xx, invalid JSON and malformed bodies; never makes up votes", async () => {
  const withResponse = response => createGetVotes({ baseUrl: "https://api.example", fetch: async () => response() });
  const input = { idea: "x", stocks };
  await assert.rejects(withResponse(() => json({ error: { message: "None of the AI voters answered." } }, 503))(input), /None of the AI voters/);
  await assert.rejects(withResponse(() => new Response("oops", { status: 500 }))(input), /500/);
  await assert.rejects(withResponse(() => new Response("<html>", { status: 200 }))(input));
  await assert.rejects(withResponse(() => json({ stocks: [] }))(input), /invalid response/);
  await assert.rejects(createGetVotes({ baseUrl: "https://api.example", fetch: async () => { throw new TypeError("network down"); } })(input), /network down/);
});
