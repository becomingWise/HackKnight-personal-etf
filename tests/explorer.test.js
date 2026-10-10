import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { allocate, basketHistory, nextSessions, scenarioPath, closeTimestamp, alignHistory } from "../experiment/math.js";
import { createBasket, restoreBasket, deleteHolding, undoDeletion, parseAmountCents,
  changePaperAmount, paperHoldings, exportBasket, formatUsdCents } from "../experiment/session.js";
import { normalizeKalshiCandles, kalshiEvent } from "../experiment/kalshi.js";
import { normalizeSnapshot, analyzeBasket, refreshSnapshot } from "../experiment/data.js";
import { createExperimentServer } from "../experiment/server.mjs";

const symbols = ["NVDA", "TSM", "AVGO", "AMD", "ASML", "MU", "INTC", "MSFT", "AAPL", "GOOGL"];
const suggestions = { source: "preview", stocks: symbols.map(symbol => ({ symbol, name: symbol })), summary: "Test companies" };
test("the journey automatically populates, edits, undoes and restores a basket without reviving deletions", () => {
  let saved = createBasket("Chips", suggestions, symbols);
  assert.deepEqual(saved.symbols, symbols);
  saved = deleteHolding(saved, "NVDA"); saved = deleteHolding(saved, "AVGO");
  assert.equal(saved.symbols.length, 8);
  saved = restoreBasket(JSON.stringify(saved), symbols);
  assert.equal(saved.symbols.includes("NVDA"), false);
  assert.equal(allocate(saved.symbols.map(symbol => ({ symbol }))).every(s => s.weightPct === 12.5), true);
  saved = undoDeletion(saved); saved = undoDeletion(saved);
  assert.deepEqual(saved.symbols, symbols);
  for (const symbol of symbols) saved = deleteHolding(saved, symbol);
  assert.equal(saved.symbols.length, 0);
  assert.equal(restoreBasket(JSON.stringify(saved), symbols).symbols.length, 0);
  assert.equal(undoDeletion(saved).symbols.length, 1);
  assert.equal(restoreBasket('{bad', symbols), null);
  assert.equal(restoreBasket(JSON.stringify({ ...saved, symbols: ["BAD"] }), symbols), null);
});
test("failed replacement suggestions leave the original basket intact", () => {
  const old = changePaperAmount(createBasket("Chips", suggestions, symbols), "buy", 10001), before = structuredClone(old);
  assert.throws(() => createBasket("Energy", { ...suggestions, stocks: [{ symbol: "XOM" }] }, symbols));
  assert.deepEqual(old, before);
});
test("paper amounts reject fractional cents, invalid values and unsafe integers without rounding", () => {
  for (const [text, cents] of [["100.50",10050],[" 12 ",1200],[".01",1],["0.10",10],["0002.5",250],["90071992547409.91",Number.MAX_SAFE_INTEGER]])
    assert.equal(parseAmountCents(text), cents);
  for (const text of ["", "0", "0.00", "-1", "+2", "1.001", "1e3", "NaN", "Infinity", "$10", "1,000", "1.", "90071992547409.92"])
    assert.throws(() => parseAmountCents(text));
});
test("paper buys add funds, partial and full sales preserve companies, and failures preserve the balance", () => {
  const empty = createBasket("Chips", suggestions, symbols);
  const first = changePaperAmount(empty, "buy", 10001);
  const second = changePaperAmount(first, "buy", 99);
  assert.equal(empty.paperAmountCents, 0);
  assert.equal(first.paperAmountCents, 10001);
  assert.equal(second.paperAmountCents, 10100);
  const sold = changePaperAmount(second, "sell", 137);
  assert.equal(sold.paperAmountCents, 9963);
  assert.deepEqual(sold.symbols, symbols);
  assert.equal(changePaperAmount(sold, "sell", 9963).paperAmountCents, 0);
  for (const [mode, amount] of [["sell", 9964],["buy",0],["buy",1.5],["buy",Infinity],["bad",1]])
    assert.throws(() => changePaperAmount(sold, mode, amount));
  assert.equal(sold.paperAmountCents, 9963);
  assert.throws(() => changePaperAmount({ ...sold, paperAmountCents:Number.MAX_SAFE_INTEGER }, "buy",1));
});
test("paper display preserves cents at the safe-integer boundary", () => {
  assert.equal(formatUsdCents(0),"$0.00");
  assert.equal(formatUsdCents(10001),"$100.01");
  assert.equal(formatUsdCents(Number.MAX_SAFE_INTEGER),"$90,071,992,547,409.91");
  assert.throws(()=>formatUsdCents(1.5));assert.throws(()=>formatUsdCents(-1));
});
test("paper allocation sums to the exact cent after deletions, undo and an empty basket", () => {
  const catalog = suggestions.stocks;
  let saved = changePaperAmount(createBasket("Chips", suggestions, symbols), "buy", 10001);
  const full = paperHoldings(saved, catalog);
  assert.equal(full.reduce((n,h) => n + h.allocatedCents, 0), 10001);
  assert.equal(full[0].allocatedCents, 1001);
  for (const symbol of symbols.slice(3)) saved = deleteHolding(saved, symbol);
  assert.deepEqual(paperHoldings(saved, catalog).map(h=>h.allocatedCents), [3334,3334,3333]);
  saved = undoDeletion(saved);
  assert.equal(paperHoldings(saved,catalog).reduce((n,h)=>n+h.allocatedCents,0), 10001);
  for (const symbol of [...saved.symbols]) saved = deleteHolding(saved, symbol);
  assert.equal(saved.paperAmountCents, 10001);
  assert.deepEqual(paperHoldings(saved, catalog), []);
  assert.throws(() => changePaperAmount(saved,"buy",100));
  assert.equal(changePaperAmount(saved,"sell",10001).paperAmountCents,0);
  const restored = undoDeletion(saved);
  assert.equal(paperHoldings(restored, catalog)[0].allocatedCents,10001);
});
test("session recovery keeps paper funds and older sessions start at zero; a successful new idea resets funds", () => {
  const old = createBasket("Chips", suggestions, symbols); delete old.paperAmountCents;
  assert.equal(restoreBasket(JSON.stringify(old),symbols).paperAmountCents,0);
  const funded = changePaperAmount(old,"buy",123456);
  assert.equal(restoreBasket(JSON.stringify(funded),symbols).paperAmountCents,123456);
  for (const paperAmountCents of [-1,1.5,null,"100",Number.MAX_SAFE_INTEGER+1])
    assert.equal(restoreBasket(JSON.stringify({...funded,paperAmountCents}),symbols),null);
  assert.equal(createBasket("Energy",suggestions,symbols).paperAmountCents,0);
});
test("export preserves paper funding, per-holding allocations and unallocated funds without invented gains", () => {
  const saved = changePaperAmount(createBasket("Chips",suggestions,symbols),"buy",123456);
  const data = exportBasket(saved,suggestions.stocks,"2026-10-10T21:00:00Z");
  assert.equal(data.paperAmountCents,123456);assert.equal(data.paperAmountUsd,1234.56);assert.equal(data.mode,"paper");
  assert.equal(data.holdings.reduce((n,h)=>n+h.allocatedCents,0),123456);
  assert.equal(data.unallocatedCents,0);assert.equal(data.exportedAt,"2026-10-10T21:00:00Z");
  assert.equal(exportBasket({...saved,symbols:[]},suggestions.stocks).unallocatedCents,123456);
  assert.equal(data.profit,undefined);
});

test("basket replay compounds equal daily returns, shares dates, and recomputes after deletion", () => {
  const dates = ["2026-10-07", "2026-10-08", "2026-10-09"];
  const stocks = [{ symbol: "NVDA", prices: dates.map((date, i) => ({ date, close: [100,110,99][i] })) },
    { symbol: "TSM", prices: dates.map((date, i) => ({ date, close: [50,45,54][i] })) }];
  const curves = basketHistory(stocks);
  assert.deepEqual(curves.basket.map(p => p.close), [100,100,105]);
  assert.deepEqual(curves.stocks.NVDA.map(p => p.close), [100,110.00000000000001,99]);
  assert.ok(Math.abs(basketHistory(stocks.slice(0,1)).basket.at(-1).close - 99) < 1e-10);
  assert.equal(basketHistory([stocks[0], { symbol: "TSM", prices: [] }]).basket.length, 0);
  assert.equal(basketHistory([stocks[0], { ...stocks[1], prices: stocks[1].prices.slice(1) }]).basket[0].date, dates[1]);
});
test("future sessions exclude weekends and planned US exchange holidays", () => {
  assert.equal(nextSessions("2026-10-09",20).at(-1), "2026-11-06");
  assert.deepEqual(nextSessions("2026-11-25",2), ["2026-11-27","2026-11-30"]);
  assert.deepEqual(nextSessions("2026-12-24",2), ["2026-12-28","2026-12-29"]);
  assert.deepEqual(nextSessions("2027-03-25",1), ["2027-03-29"]);
  assert.deepEqual(nextSessions("2027-12-30",1), ["2027-12-31"]);
});
test("early-close alignment excludes odds learned after the equity close", () => {
  assert.equal(new Date(closeTimestamp("2025-11-28") * 1000).toISOString(), "2025-11-28T18:00:00.000Z");
  assert.equal(new Date(closeTimestamp("2025-07-03") * 1000).toISOString(), "2025-07-03T17:00:00.000Z");
  assert.equal(new Date(closeTimestamp("2026-12-24") * 1000).toISOString(), "2026-12-24T18:00:00.000Z");
  assert.equal(new Date(closeTimestamp("2027-07-02") * 1000).toISOString(), "2027-07-02T20:00:00.000Z");
  const prices = [{ date: "2025-11-26", close: 100 }, { date: "2025-11-28", close: 101 }];
  const history = [{ timestamp: closeTimestamp(prices[0].date) - 60, price: .2 },
    { timestamp: closeTimestamp(prices[1].date) - 60, price: .3 },
    { timestamp: closeTimestamp(prices[1].date) + 3600, price: .8 }];
  assert.ok(Math.abs(alignHistory(prices, prices, history)[0].x - .1) < 1e-12);
});
test("the future path anchors at history and applies the cumulative shock only once", () => {
  const history = [{ date: "2026-10-08", close: 90 }, { date: "2026-10-09", close: 100 }];
  const fit = { status: "weak", slope: .2, se: .1, maxDailyMove: .05 };
  const path = scenarioPath(history, fit, .2, .3);
  assert.equal(path.points.length, 21);
  assert.equal(path.points[0].close, 100);
  assert.equal(path.points.at(-1).close, 102);
  assert.ok(path.points[10].close > 100 && path.points[10].close < 102);
  assert.ok(path.points.at(-1).low < 102 && path.points.at(-1).high > 102);
  assert.equal(path.extrapolated, true);
  const negative = scenarioPath(history, { ...fit, slope: -.2 }, .2, .3);
  assert.equal(negative.points.at(-1).close, 98);
  assert.ok(scenarioPath(history, fit, .2, .2).points.every(p => p.close === 100 && p.low === 100 && p.high === 100));
  assert.deepEqual(scenarioPath(history, null, .2, .3).points, []);
  assert.deepEqual(scenarioPath(history, { ...fit, slope: -100 }, .2, .8).points, []);
  assert.equal(history.at(-1).close, 100);
});

const candle = (timestamp, bid = "0.2", ask = "0.4") => ({ end_period_ts: timestamp, yes_bid: { close_dollars: bid }, yes_ask: { close_dollars: ask } });
test("Kalshi quote history handles fixed-point strings, nulls, crossed quotes and future bars", () => {
  const points = normalizeKalshiCandles([candle(1),candle(1),candle(2,null),candle(3,"0.5","0.2"),candle(4,"0","0"),candle(11),
    { end_period_ts: 5, price: { previous_dollars: "0.9" } }],10);
  assert.equal(points.length,2);
  assert.ok(Math.abs(points[0].price-.3)<1e-12);
  assert.equal(points[1].price,0);
});
test("Kalshi selects a real open binary contract and never joins different expirations", async () => {
  const now = Date.parse("2026-10-10T12:00:00Z"), urls=[];
  const market = { ticker: "KXIPOOPENAI-JAN", event_ticker: "KXIPOOPENAI", title: "OpenAI IPO?", yes_sub_title: "January 2027", rules_primary: "Announce IPO", close_time: "2027-01-01", open_time: "2026-10-01", volume_fp: "100", yes_bid_dollars: "0.2", yes_ask_dollars: "0.4", market_type: "binary", status: "active" };
  const fake = async url => { urls.push(url); return new Response(JSON.stringify(url.includes('/markets?') ? { markets: [market, { ...market, ticker: "KXIPOOPENAI-JUNE", volume_fp: "10" }, { ...market, ticker: "EXPIRED", close_time: "2026-01-01", volume_fp: "99999" }] } : { candlesticks: [candle(now/1000-3600)] })); };
  const event = await kalshiEvent({ series: "KXIPOOPENAI", topicId: "openai_1t", match: /ipo/i }, { label:"OpenAI", betas:{ NVDA:999 } }, fake, now);
  assert.equal(event.marketId,market.ticker); assert.equal(event.provider,"kalshi"); assert.equal(event.betas,undefined);
  assert.equal(event.history.length,1); assert.ok(urls.filter(u=>u.includes('candlesticks')).every(u=>u.includes('/KXIPOOPENAI-JAN/')));
  const missing = await kalshiEvent({ series: "KXIPOOPENAI", topicId: "openai_1t", match: /ipo/i }, { label:"OpenAI", betas:{NVDA:1} }, async url => url.includes('/markets?') ? fake(url) : new Response('{}',{status:503}),now);
  assert.equal(missing.status,"available"); assert.equal(missing.history.length,0); assert.match(missing.historyError,/503/);
});

function observedFixture() {
  let nvidia=100, tsm=100, spy=100, odds=.5;
  const stocks={NVDA:{prices:[]},TSM:{prices:[]},SPY:{prices:[]}}, history=[];
  for(let offset=0,i=0;i<181;offset++) {
    const d=new Date(Date.UTC(2026,0,1+offset)); if([0,6].includes(d.getUTCDay()))continue;
    const date=d.toISOString().slice(0,10), x=Math.sin(i*2.17)*.02, z=Math.cos(i*1.39)*.005;
    odds+=x; nvidia*=1+.4*x+z+Math.sin(i*.77)*.001;tsm*=1-.2*x+z;spy*=1+z;
    for(const [s,v] of [["NVDA",nvidia],["TSM",tsm],["SPY",spy]])stocks[s].prices.push({date,close:v});
    history.push({timestamp:closeTimestamp(date)-60,price:odds});i++;
  }
  return {schemaVersion:1,builtAt:"2026-10-10",stocks,events:[{id:"taiwan",marketId:"poly1",status:"available",linkedSymbols:["NVDA","TSM"],probability:.5,history},
    {id:"kalshi:K1",topicId:"taiwan",provider:"kalshi",marketId:"K1",status:"available",linkedSymbols:["NVDA"],probability:.4,history},
    {id:"kalshi:missing",topicId:"taiwan",provider:"kalshi",status:"unavailable",linkedSymbols:["NVDA"],history:[],reason:"No data"}]};
}
test("analysis fits the basket directly, separates providers and survives missing event data", () => {
  const fixture=observedFixture(), result=analyzeBasket(fixture,["NVDA","TSM"]);
  assert.equal(normalizeSnapshot(fixture).events[0].id,"polymarket:poly1");
  assert.equal(result.basketHistory[0].close,100);
  const poly=result.events.find(e=>e.provider==='polymarket'), kalshi=result.events.find(e=>e.marketId==='K1');
  assert.ok(Math.abs(poly.fit.slope-.1)<.03);
  assert.ok(Math.abs(poly.stockFits.NVDA.slope-.4)<.03);
  assert.equal(kalshi.stockFits.TSM,undefined);assert.equal(kalshi.marketId,'K1');
  assert.equal(result.events.find(e=>e.status==='unavailable').fit.status,'insufficient');
  assert.equal(result.providerStatus.polymarket.available,1);assert.equal(result.providerStatus.kalshi.unavailable,1);
  assert.ok(Number.isFinite(poly.fit.qValue));assert.equal(poly.fit.points,undefined);assert.ok(poly.history.length>100);
  assert.throws(()=>analyzeBasket(fixture,[]));assert.throws(()=>analyzeBasket(fixture,['NVDA','NVDA']));assert.throws(()=>analyzeBasket(fixture,['BAD']));
  assert.notEqual(analyzeBasket(fixture,['NVDA']).basketHistory.at(-1).close,result.basketHistory.at(-1).close);
  const shortened = structuredClone(fixture); shortened.stocks.TSM.prices = shortened.stocks.TSM.prices.slice(-91);
  const shorter = analyzeBasket(shortened, ['NVDA','TSM']).events.find(e => e.provider === 'polymarket');
  assert.equal(shorter.stockFits.NVDA.n, poly.stockFits.NVDA.n);
  assert.ok(shorter.fit.n < shorter.stockFits.NVDA.n);
});
test("an upstream outage preserves previous observed data and marks it stale", async () => {
  const fixture=observedFixture();fixture.events[0].endDate='2027-12-31';
  const refreshed=await refreshSnapshot({previous:fixture,fetch:async()=>new Response('{}',{status:503})});
  assert.equal(refreshed.stocks.NVDA.stale,true);
  assert.equal(refreshed.events.find(e=>e.provider==='polymarket'&&e.topicId==='taiwan').stale,true);
  assert.equal(refreshed.schemaVersion,2);
});
test("all pages reload through the server; suggestions use server mode and analysis validates inputs", async () => {
  const server=(await createExperimentServer({snapshot:observedFixture(),suggestionMode:'preview'})).listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const post=(path,body)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  try {
    for(const path of ['/','/basket','/events','/charts.js','/session.js'])assert.equal((await fetch(base+path)).status,200);
    assert.equal((await(post('/api/stocks',{idea:'Chips'}))).status,200);
    assert.equal((await(await post('/api/stocks',{idea:'Chips'})).json()).stocks.length,10);
    assert.equal((await post('/api/analysis',{symbols:['NVDA','TSM']})).status,200);
    for(const symbols of [[],['BAD'],['NVDA','NVDA']])assert.equal((await post('/api/analysis',{symbols})).status,400);
    assert.equal((await fetch(base+'/capitalization.example.json')).status,404);
  }finally{server.close();}
});
test("Gemini mode never falls back to example stocks on a failure", async () => {
  const server=(await createExperimentServer({snapshot:observedFixture(),suggestionMode:'gemini',suggest:async()=>{throw new Error('Invalid key');}})).listen(0,'127.0.0.1');await once(server,'listening');
  try {const r=await fetch(`http://127.0.0.1:${server.address().port}/api/stocks`,{method:'POST',body:JSON.stringify({idea:'Chips'})});const data=await r.json();assert.equal(r.status,502);assert.equal(data.stocks,undefined);assert.match(data.error.message,/Invalid key/);}finally{server.close();}
});
