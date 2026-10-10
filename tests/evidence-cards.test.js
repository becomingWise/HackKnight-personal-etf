import test from "node:test";
import assert from "node:assert/strict";
import { buildEvidenceCards, renderEvidenceCards, CAVEAT, EMPTY_MESSAGE } from "../js/evidence-cards.js";
import { createEventRisk } from "../js/risk-adapter.js";

// Shapes copied from live /api/weights and /api/risk answers (2026-10-10), shortened.
const recession = {
  title: "US recession by end of 2026?",
  url: "https://polymarket.com/event/us-recession-by-end-of-2026",
  outcome: "Yes",
  probability: 0.065,
  observedAt: "2026-10-10T16:34:36.875Z",
  change7d: -0.01,
  symbols: ["JPM", "TLT"]
};
const chips = {
  title: "Will AI-chip export licensing become law this year?",
  url: "https://polymarket.com/event/which-bills-will-become-law-in-2026",
  outcome: "Yes",
  probability: 0.225,
  observedAt: "2026-10-10T16:34:36.875Z",
  change7d: 0.13,
  symbols: ["NVDA"]
};
const adjustment = (evidence) => ({ status: "adjusted", explanation: "Tilted by Polymarket odds moves.", evidence });
const risk = {
  markets: [
    { title: chips.title, url: chips.url, probability: 0.225, ifYesPct: -1.395, ifNoPct: 0.405, drivers: [] },
    { title: recession.title, url: recession.url, probability: 0.065, ifYesPct: 1.496, ifNoPct: -0.104, drivers: [] }
  ],
  uncovered: [],
  basis: "Sensitivities are hand-set estimates.",
  note: "Event probabilities indicate risk, not expected returns: details."
};
const fixedTime = () => "4:34 PM";

test("one card per evidence item, in evidence order, with odds, weekly move, tickers and time", () => {
  const view = buildEvidenceCards(adjustment([recession, chips]), null, { formatTime: fixedTime });
  assert.equal(view.explanation, "Tilted by Polymarket odds moves.");
  assert.deepEqual(view.cards.map((card) => card.title), [recession.title, chips.title]);
  assert.deepEqual(view.cards[0], {
    title: recession.title,
    url: recession.url,
    odds: "Yes 6.5%",
    move: "▼ 1.0 pts this week",
    tickers: "JPM, TLT",
    asOf: "as of 4:34 PM",
    risk: null
  });
  assert.equal(view.cards[1].move, "▲ 13.0 pts this week");
});

test("weekly move reads 'no weekly change data' when change7d is null, and 'flat' when it rounds to zero", () => {
  const view = buildEvidenceCards(
    adjustment([{ ...recession, change7d: null }, { ...chips, change7d: 0.0001 }]),
    null,
    { formatTime: fixedTime }
  );
  assert.equal(view.cards[0].move, "No weekly change data");
  assert.equal(view.cards[1].move, "Flat this week");
});

test("risk numbers join onto the matching card by url and title, with explicit signs", () => {
  const view = buildEvidenceCards(adjustment([recession, chips]), risk, { formatTime: fixedTime });
  assert.equal(view.cards[0].risk, "If yes: +1.5% · If no: −0.1%");
  assert.equal(view.cards[1].risk, "If yes: −1.4% · If no: +0.4%");
});

test("a risk market with the same url but a different question does not match", () => {
  const sameEventOtherMarket = { ...risk.markets[1], title: "Some other bill in the same event?" };
  const view = buildEvidenceCards(adjustment([recession]), { ...risk, markets: [sameEventOtherMarket] }, { formatTime: fixedTime });
  assert.equal(view.cards[0].risk, null);
});

test("the caveat is always present; the risk note and basis are added when risk data is there", () => {
  assert.deepEqual(buildEvidenceCards(adjustment([recession]), null).notes, [CAVEAT]);
  assert.deepEqual(buildEvidenceCards(adjustment([recession]), risk).notes, [CAVEAT, risk.note, risk.basis]);
});

test("uncovered tickers get one 'no measurable event exposure' line", () => {
  assert.equal(buildEvidenceCards(adjustment([recession]), risk).uncovered, null);
  const view = buildEvidenceCards(adjustment([recession]), { ...risk, uncovered: ["AAPL", "KO"] });
  assert.equal(view.uncovered, "No measurable event exposure: AAPL, KO");
});

test("no evidence gives the empty message and no cards", () => {
  const view = buildEvidenceCards({ status: "unchanged", explanation: "No relevant markets.", evidence: [] }, null);
  assert.deepEqual(view.cards, []);
  assert.equal(view.empty, EMPTY_MESSAGE);
  assert.equal(buildEvidenceCards(adjustment([recession]), null).empty, null);
});

test("a missing adjustment (still loading) is treated as no evidence", () => {
  const view = buildEvidenceCards(undefined, null);
  assert.deepEqual(view.cards, []);
  assert.equal(view.explanation, "");
});

// Minimal stand-in for the DOM: enough to see what renderEvidenceCards builds, and that it never uses innerHTML.
function fakeDocument() {
  const make = (tag) => {
    const node = {
      tag, children: [], attributes: {}, className: "", textContent: "",
      append(...kids) { node.children.push(...kids); },
      replaceChildren(...kids) { node.children = [...kids]; },
      setAttribute(name, value) { node.attributes[name] = String(value); }
    };
    Object.defineProperty(node, "innerHTML", { set() { throw new Error("innerHTML must not be used"); } });
    return node;
  };
  return { createElement: make };
}
const walk = (node, out = []) => { out.push(node); node.children.forEach((kid) => walk(kid, out)); return out; };

test("renderEvidenceCards puts market text in textContent and opens links safely", () => {
  const doc = fakeDocument();
  const container = doc.createElement("div");
  const hostile = { ...recession, title: "<img src=x onerror=alert(1)>" };
  renderEvidenceCards(container, adjustment([hostile]), risk, { document: doc, formatTime: fixedTime });
  const nodes = walk(container);
  const link = nodes.find((node) => node.tag === "a");
  assert.equal(link.textContent, hostile.title);
  assert.equal(link.attributes.href, hostile.url);
  assert.equal(link.attributes.target, "_blank");
  assert.equal(link.attributes.rel, "noopener noreferrer");
  assert.ok(nodes.some((node) => node.textContent === CAVEAT));
});

test("renderEvidenceCards replaces earlier content, so it can be called again on every refresh", () => {
  const doc = fakeDocument();
  const container = doc.createElement("div");
  renderEvidenceCards(container, adjustment([recession, chips]), null, { document: doc });
  renderEvidenceCards(container, adjustment([]), null, { document: doc });
  const texts = walk(container).map((node) => node.textContent);
  assert.ok(texts.includes(EMPTY_MESSAGE));
  assert.ok(!texts.includes(recession.title));
});

test("renderEvidenceCards skips a link whose url is not http(s)", () => {
  const doc = fakeDocument();
  const container = doc.createElement("div");
  renderEvidenceCards(container, adjustment([{ ...recession, url: "javascript:alert(1)" }]), null, { document: doc });
  const nodes = walk(container);
  assert.equal(nodes.find((node) => node.tag === "a"), undefined);
  assert.ok(nodes.some((node) => node.textContent === recession.title));
});

test("eventRisk posts the holdings to /api/risk and returns the JSON", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => risk };
  };
  const eventRisk = createEventRisk({ baseUrl: "http://localhost:3000/", fetch });
  const holdings = [{ symbol: "TLT", weightPct: 100 }];
  const signal = new AbortController().signal;
  assert.deepEqual(await eventRisk({ holdings }, { signal }), risk);
  assert.equal(calls[0].url, "http://localhost:3000/api/risk");
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { holdings });
  assert.equal(calls[0].init.signal, signal);
});

test("eventRisk rejects with the server's error message", async () => {
  const fetch = async () => ({
    ok: false,
    status: 422,
    json: async () => ({ error: { code: "invalid_request", message: "Weights must total 100." } })
  });
  await assert.rejects(createEventRisk({ fetch })({ holdings: [] }), /Weights must total 100\./);
});
