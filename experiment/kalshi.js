const BASE = "https://external-api.kalshi.com/trade-api/v2";
let nextRequest = 0;
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
// Verified series: broader business topics, NOT purportedly identical Polymarket outcomes.
export const KALSHI_TOPICS = [
  { topicId: "openai_1t", series: "KXIPOOPENAI", match: /openai.*ipo/i },
  { topicId: "ai_safety_bill", series: "KXAISAFETYAUDIT", match: /independent ai safety/i },
  { topicId: "no_cuts", series: "KXRATECUTCOUNT", match: /cut rates 0 times|exactly 0 cuts/i, currentYear: true },
  { topicId: "recession", series: "KXRECSSNBER", match: /recession/i, currentYear: true },
  { topicId: "hormuz_normal", series: "KXHORMUZNORM", match: /strait of hormuz/i },
  { topicId: "iran_deal", series: "KXUSAIRANAGREEMENT", match: /iran.*nuclear|iranian nuclear/i },
  { topicId: "btc_100k", series: "KXBTCMAX100", match: /bitcoin.*100[,.]?000/i },
];
const number = value => value == null || value === "" ? null : Number.isFinite(Number(value)) ? Number(value) : null;
const probability = value => { const n = number(value); return n != null && n >= 0 && n <= 1 ? n : null; };
const midpoint = (bid, ask) => { const b = probability(bid), a = probability(ask); return b != null && a != null && a >= b ? (a + b) / 2 : null; };
async function get(url, fetchFn) {
  for (let attempt = 0; attempt < 4; attempt++) {
    // A shared pace across workers avoids exhausting public-read limits during refresh.
    if (fetchFn === fetch) {
      const delay = Math.max(0, nextRequest - Date.now());
      nextRequest = Math.max(Date.now(), nextRequest) + 400;
      if (delay) await wait(delay);
    }
    const r = await fetchFn(url, { headers: { "User-Agent": "BasketLab local research preview" }, signal: AbortSignal.timeout(15000) });
    if (r.status === 429 && attempt < 3 && fetchFn === fetch) {
      await wait(Math.min(10000, Math.max(Number(r.headers.get("retry-after")) * 1000 || 0, 1000 * 2 ** attempt))); continue;
    }
    if (!r.ok) throw new Error(`Kalshi public data returned HTTP ${r.status}.`);
    return r.json();
  }
}

export function normalizeKalshiCandles(candles, now = Date.now() / 1000) {
  return [...new Map(candles.map(c => ({ timestamp: c.end_period_ts,
    price: midpoint(c.yes_bid?.close_dollars, c.yes_ask?.close_dollars) }))
    .filter(p => Number.isFinite(p.timestamp) && p.timestamp <= now && p.price != null)
    .map(p => [p.timestamp, p])).values()].sort((a, b) => a.timestamp - b.timestamp);
}

export async function kalshiEvent(cfg, topic, fetchFn = fetch, now = Date.now()) {
  let cursor, markets = [];
  for (let page = 0; page < 10; page++) {
    const query = new URLSearchParams({ series_ticker: cfg.series, status: "open", limit: "100", ...(cursor ? { cursor } : {}) });
    const data = await get(`${BASE}/markets?${query}`, fetchFn);
    markets.push(...(data.markets ?? []));
    cursor = data.cursor; if (!cursor) break;
  }
  const year = new Date(now).getUTCFullYear();
  markets = markets.filter(m => m.market_type === "binary" && ["active", "open"].includes(m.status) && Date.parse(m.close_time) > now &&
    cfg.match.test(`${m.title} ${m.yes_sub_title} ${m.rules_primary}`) &&
    (!cfg.currentYear || `${m.title} ${m.rules_primary}`.includes(String(year))));
  markets.sort((a, b) => Number(b.volume_fp ?? 0) - Number(a.volume_fp ?? 0) || a.ticker.localeCompare(b.ticker));
  const m = markets.find(m => midpoint(m.yes_bid_dollars, m.yes_ask_dollars) != null);
  if (!m) throw new Error(`No usable open Kalshi contract in ${cfg.series}.`);
  const end = Math.floor(now / 1000), start = Math.max(end - 365 * 86400, Math.floor(Date.parse(m.open_time) / 1000) || 0);
  const candles = [];
  let historyError = null;
  // Short bounded windows keep each response below the candle limit. Never splice contracts.
  try {
    for (let from = start; from < end; from += 30 * 86400) {
      const query = new URLSearchParams({ start_ts: String(from), end_ts: String(Math.min(end, from + 30 * 86400)), period_interval: "60" });
      const data = await get(`${BASE}/series/${cfg.series}/markets/${encodeURIComponent(m.ticker)}/candlesticks?${query}`, fetchFn);
      candles.push(...(data.candlesticks ?? []));
    }
  } catch (err) { historyError = err.message; }
  return { id: `kalshi:${m.ticker}`, provider: "kalshi", topicId: cfg.topicId, marketId: m.ticker, seriesTicker: cfg.series,
    eventTicker: m.event_ticker, label: topic.label, linkedSymbols: Object.keys(topic.betas), status: "available",
    title: m.title, subtitle: m.yes_sub_title, rules: m.rules_primary,
    url: `https://kalshi.com/markets/${cfg.series.toLowerCase()}`,
    probability: midpoint(m.yes_bid_dollars, m.yes_ask_dollars), oddsKind: "Yes bid/ask midpoint",
    volume: Number(m.volume_fp ?? 0), endDate: m.close_time, observedAt: new Date(now).toISOString(),
    history: normalizeKalshiCandles(candles, end), historyError,
    historySource: `${BASE}/series/${cfg.series}/markets/${m.ticker}/candlesticks`,
  };
}
