import { readFile, writeFile, mkdir } from "node:fs/promises";
import { COMPANIES } from "./suggestions.js";
import { association, qualifyAssociations, basketHistory, allocate } from "./math.js";
import { KALSHI_TOPICS, kalshiEvent } from "./kalshi.js";
import { weeklyOddsChange } from "./evidence.js";

const UNIVERSE = JSON.parse(await readFile(new URL("../backend/src/polyslice_api/data/universe.json", import.meta.url), "utf8"));
const HEADER = { "User-Agent": "Mozilla/5.0 (BasketLab local research preview)" };
const strings = value => { try { return Array.isArray(value) ? value : JSON.parse(value ?? "[]"); } catch { return []; } };

async function getJSON(url, fetchFn) {
  const r = await fetchFn(url, { headers: HEADER, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`Public data source returned HTTP ${r.status}.`);
  return r.json();
}

async function pool(items, worker, concurrency = 4) {
  const out = new Array(items.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) { const i = cursor++; out[i] = await worker(items[i]); }
  }));
  return out;
}

export async function stockHistory(symbol, fetchFn = fetch) {
  const source = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
  const body = await getJSON(source, fetchFn);
  const chart = body.chart?.result?.[0];
  if (!chart) throw new Error("Stock-price history unavailable.");
  const values = chart.indicators?.adjclose?.[0]?.adjclose;
  if (!values) throw new Error("Adjusted-close prices unavailable.");
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const prices = (chart.timestamp ?? []).map((time, i) => ({ date: new Date(time * 1000).toISOString().slice(0, 10), close: values[i] }))
    .filter(p => Number.isFinite(p.close) && p.close > 0 && p.date < today);
  return { prices, currency: chart.meta?.currency, source, observedAt: new Date().toISOString() };
}

export async function eventHistory(cfg, fetchFn = fetch) {
  const source = new URL("https://gamma-api.polymarket.com/public-search");
  source.search = new URLSearchParams({ q: cfg.query, limit_per_type: "30", events_status: "active", keep_closed_markets: "0" });
  const body = await getJSON(source.href, fetchFn);
  const candidates = (body.events ?? []).filter(e => !e.closed).flatMap(e => (e.markets ?? []).map(m => ({ event: e, market: m })))
    .filter(({ market: m }) => m.active && !m.closed && m.question?.toLowerCase().includes(cfg.match.toLowerCase()));
  candidates.sort((a, b) => Number(b.market.volumeNum ?? b.market.volume ?? 0) - Number(a.market.volumeNum ?? a.market.volume ?? 0));
  const match = candidates[0];
  if (!match) return { ...cfg, betas: undefined, linkedSymbols: Object.keys(cfg.betas), status: "unavailable", reason: "No open market matched the configured event.", history: [] };
  const { market: m, event } = match;
  const yes = strings(m.outcomes).findIndex(outcome => String(outcome).toLowerCase() === "yes");
  if (yes < 0) throw new Error("This event has no Yes outcome.");
  const probability = Number(strings(m.outcomePrices)[yes]);
  if (!(probability > 0 && probability < 1)) throw new Error("No usable open-market probability.");
  const tokens = [...new Set([strings(m.positionIds)[yes], strings(m.clobTokenIds)[yes]].filter(Boolean))];
  let history = [], historySource = null;
  // Both IDs describe the very same market and outcome. The migrated token often has no
  // history yet; the legacy token retains it. Never mix different expiry contracts here.
  for (const token of tokens) {
    const points = [];
    let cursor;
    for (let page = 0; page < 12; page++) {
      const url = new URL("https://data-api.polymarket.com/v2/prices-history");
      url.search = new URLSearchParams({ token_id: String(token), interval: "max", bucket_seconds: "43200", limit: "1000", ...(cursor ? { cursor } : {}) });
      const response = await getJSON(url.href, fetchFn);
      points.push(...(response.data ?? []).filter(p => p.resolution_seconds > 0).map(p => ({ timestamp: p.timestamp, price: p.price })));
      if (!response.pagination?.has_more || !response.pagination.next_cursor) break;
      cursor = response.pagination.next_cursor;
    }
    if (points.length > history.length) {
      history = [...new Map(points.map(p => [p.timestamp, p])).values()].sort((a, b) => a.timestamp - b.timestamp);
      historySource = `https://data-api.polymarket.com/v2/prices-history?token_id=${token}&interval=max&bucket_seconds=43200`;
    }
  }
  return { id: cfg.id, label: cfg.label, linkedSymbols: Object.keys(cfg.betas), status: "available", marketId: String(m.id),
    title: m.question, url: `https://polymarket.com/event/${event.slug}`, probability,
    liquidity: Number(m.liquidityNum ?? m.liquidity ?? 0), volume: Number(m.volumeNum ?? m.volume ?? 0),
    observedAt: new Date().toISOString(), endDate: m.endDate, history, historySource,
  };
}

export function normalizeSnapshot(data) {
  return { ...data, schemaVersion: 2, events: (data.events ?? []).map(e => ({ ...e,
    topicId: e.topicId ?? e.id, provider: e.provider ?? "polymarket",
    id: e.provider ? e.id : `polymarket:${e.marketId ?? e.id}`, oddsKind: e.oddsKind ?? "Yes outcome price",
  })) };
}

export async function refreshSnapshot({ fetch: fetchFn = fetch, previous } = {}) {
  const old = normalizeSnapshot(previous ?? await loadSnapshot());
  const stocks = await pool([...COMPANIES, { symbol: "SPY", name: "S&P 500 ETF" }], async stock => {
    try { return { ...stock, ...await stockHistory(stock.symbol, fetchFn) }; }
    catch (err) { return { ...stock, ...(old.stocks[stock.symbol] ?? { prices: [] }), error: err.message, stale: true }; }
  });
  const work = [...UNIVERSE.signals.map(topic => ({ provider: "polymarket", topic })),
    ...KALSHI_TOPICS.map(cfg => ({ provider: "kalshi", cfg, topic: UNIVERSE.signals.find(s => s.id === cfg.topicId) }))];
  const events = await pool(work, async ({ provider, cfg, topic }) => {
    try { return provider === "kalshi" ? await kalshiEvent(cfg, topic, fetchFn) : { ...await eventHistory(topic, fetchFn), provider, topicId: topic.id }; }
    catch (err) {
      const retained = old.events.find(e => e.provider === provider && e.topicId === topic.id && e.status === "available" && Date.parse(e.endDate) > Date.now());
      return retained ? { ...retained, stale: true, reason: err.message }
        : { id: `${provider}:${topic.id}:unavailable`, provider, topicId: topic.id, label: topic.label,
          linkedSymbols: Object.keys(topic.betas), history: [], status: "unavailable", reason: err.message };
    }
  });
  for (const event of events) if (event.provider === "polymarket" && event.marketId) event.id = `polymarket:${event.marketId}`;
  if (!stocks.find(s => s.symbol === "SPY")?.prices.length || !events.some(e => e.status === "available")) {
    throw new Error("Could not refresh usable public stock and event data. The previous snapshot is retained.");
  }
  return { schemaVersion: 2, builtAt: new Date().toISOString(),
    note: "Observed data. Polymarket uses 12-hour prices; Kalshi uses hourly Yes bid/ask midpoints. Fits use observations before the US close, at most 18 hours old. Future paths are illustrative scenarios.",
    stocks: Object.fromEntries(stocks.map(s => [s.symbol, s])), events,
  };
}

const CACHE = new URL("./.cache/snapshot.json", import.meta.url);
const SNAPSHOT = new URL("./data/snapshot.json", import.meta.url);

export async function loadSnapshot() {
  const candidates = [];
  for (const path of [CACHE, SNAPSHOT]) {
    try {
      const data = JSON.parse(await readFile(path, "utf8"));
      if ([1, 2].includes(data.schemaVersion) && data.stocks && Array.isArray(data.events)) candidates.push(normalizeSnapshot(data));
    } catch { /* try the other snapshot */ }
  }
  candidates.sort((a, b) => (Date.parse(b.builtAt) || 0) - (Date.parse(a.builtAt) || 0));
  if (candidates.length) return candidates[0];
  return { schemaVersion: 2, builtAt: null, stocks: {}, events: [], note: "Refresh public observations to load historical data." };
}

export async function saveSnapshot(data, committed = false) {
  const path = committed ? SNAPSHOT : CACHE;
  await mkdir(new URL(".", path), { recursive: true });
  await writeFile(path, JSON.stringify(data));
}

const BUSINESS = {
  taiwan: "Taiwan's semiconductor supply chain and the geopolitical exposure of global businesses.",
  no_cuts: "Interest rates affect financing costs, bank margins and valuations.",
  recession: "A slowdown can affect spending, lending, energy demand and cyclical revenues.",
  hormuz_normal: "Shipping disruption changes energy supply and transportation costs.",
  bab_closed: "Shipping-route disruption can affect energy and goods transport.",
  iran_deal: "A nuclear agreement can change oil supply and regional geopolitical risk.",
  ukraine_ceasefire: "A ceasefire can change defense demand and energy supply expectations.",
  btc_100k: "Crypto prices influence exchange activity and companies holding or mining bitcoin.",
  chip_export_law: "Export restrictions can affect access to customers for advanced chips and equipment.",
  openai_1t: "AI valuations and financing can affect AI infrastructure suppliers and competing platforms.",
  ai_safety_bill: "AI regulation can change compliance costs and product development.",
};

export function stockEvents(snapshot, symbol) {
  const stock = snapshot.stocks[symbol];
  const benchmark = snapshot.stocks.SPY?.prices ?? [];
  const events = snapshot.events.filter(e => e.linkedSymbols.includes(symbol)).map(e => ({
    ...e, history: undefined, businessLink: BUSINESS[e.topicId ?? e.id],
    // The research map selects plausible links only. Its hand-set betas are NEVER used in
    // the numerical slider; the stock's own overlapping observed data supplies the slope.
    fit: association(stock?.prices ?? [], benchmark, e.history),
  }));
  return qualifyAssociations(events).sort((a, b) => (b.fit.partialR2 ?? -1) - (a.fit.partialR2 ?? -1));
}

const summaryFit = fit => { const { points, ...summary } = fit; return summary; };

export function analyzeBasket(input, symbols) {
  if (!Array.isArray(symbols) || !symbols.length || symbols.length > 10 || new Set(symbols).size !== symbols.length ||
    symbols.some(symbol => !COMPANIES.some(s => s.symbol === symbol))) throw new Error("Choose 1–10 unique company tickers from your basket.");
  const snapshot = normalizeSnapshot(input);
  const holdings = allocate(symbols.map(symbol => COMPANIES.find(s => s.symbol === symbol)));
  const curves = basketHistory(symbols.map(symbol => ({ symbol, prices: snapshot.stocks[symbol]?.prices ?? [] })));
  const benchmark = snapshot.stocks.SPY?.prices ?? [];
  const related = snapshot.events.filter(e => e.linkedSymbols.some(s => symbols.includes(s)));
  const events = related.map(e => ({ ...e, weeklyMove: weeklyOddsChange(e), businessLink: BUSINESS[e.topicId] ?? "Related business exposure.",
    linkedHoldings: symbols.filter(s => e.linkedSymbols.includes(s)),
    fit: association(curves.basket, benchmark, e.history ?? []),
    stockFits: Object.fromEntries(symbols.filter(s => e.linkedSymbols.includes(s))
      .map(symbol => [symbol, association(snapshot.stocks[symbol]?.prices ?? [], benchmark, e.history ?? [])])),
  }));
  qualifyAssociations(events);
  for (const symbol of symbols) qualifyAssociations(events.filter(e => e.stockFits[symbol]).map(e => ({ fit: e.stockFits[symbol] })));
  for (const event of events) {
    event.fit = summaryFit(event.fit);
    event.stockFits = Object.fromEntries(Object.entries(event.stockFits).map(([s, fit]) => [s, summaryFit(fit)]));
  }
  events.sort((a, b) => Number(b.status === "available") - Number(a.status === "available") ||
    (b.fit.partialR2 ?? -1) - (a.fit.partialR2 ?? -1) || a.id.localeCompare(b.id));
  return { builtAt: snapshot.builtAt, holdings, basketHistory: curves.basket, stockHistories: curves.stocks, events,
    historyReason: curves.basket.length < 2 ? "Some holdings are missing price history; a common basket chart is unavailable." : null,
    providerStatus: Object.fromEntries(["polymarket", "kalshi"].map(provider => [provider, {
      available: related.filter(e => e.provider === provider && e.status === "available").length,
      unavailable: related.filter(e => e.provider === provider && e.status !== "available").length,
      stale: related.some(e => e.provider === provider && e.stale),
    }])) };
}
