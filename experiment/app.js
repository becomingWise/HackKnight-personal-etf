import { allocate, scenarioPath } from "./math.js";
import { SESSION_KEY, createBasket, restoreBasket, deleteHolding, undoDeletion } from "./session.js";
import { escape, chartMarkup, bindCharts } from "./charts.js";

const $ = selector => document.querySelector(selector);
const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "Unavailable";
const signed = value => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const sourceName = provider => provider === "kalshi" ? "Kalshi" : "Polymarket";
const safeUrl = value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? escape(url.href) : "#"; } catch { return "#"; } };
const dateTime = value => value ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET" : "Unavailable";
const fitLabel = fit => fit?.status === "observed" ? "Observed association" : fit?.status === "insufficient" || !fit ? "Not enough history" : "Weak evidence";
const state = { overview: null, saved: null, analysis: null, eventId: null, stock: null, filter: "all", target: null, range: 63, request: 0, busy: false };
const sessionId = crypto.randomUUID();

async function api(path, body) {
  const response = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": sessionId }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "The request failed.");
  return result;
}
function error(message = "") { const node = $("#error"); if (node) { node.hidden = !message; node.textContent = message; } }
function save() { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.saved)); } catch { error("This browser cannot save the basket across refreshes. You can still explore it here."); } }
const holdings = () => allocate((state.saved?.symbols ?? []).map(symbol => state.overview.stocks.find(s => s.symbol === symbol)));
const currentEvent = () => state.analysis?.events.find(e => e.id === state.eventId);
const visibleEvents = () => state.analysis.events.filter(e => state.filter === "all" || e.provider === state.filter);
const header = step => `<header class="topbar"><a class="brand" href="/" data-route="/" aria-label="Basket Lab home"><span class="brandmark">b.</span> basket<span>lab</span></a><nav class="steps" aria-label="Your basket journey">${[["Idea", "/"], ["Basket", "/basket"], ["Events", "/events"]].map(([name, path], i) => `<${i && !state.saved?.symbols.length ? "span" : "a"} ${i && !state.saved?.symbols.length ? "" : `href="${path}" data-route="${path}"`} ${step === i+1 ? 'aria-current="step"' : ""}><span>${i+1}</span>${name}</${i && !state.saved?.symbols.length ? "span" : "a"}>`).join("")}</nav><span class="experiment-badge">YOUR EXPERIMENT</span></header>`;
const errorNode = '<p id="error" class="error" role="alert" hidden></p>';
const footer = '<footer><span>basketlab / local experiment</span><span>Paper basket · illustrative scenarios</span></footer>';

function navigate(path, replace = false) {
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  void renderPage(); window.scrollTo(0, 0);
}
function renderIdea() {
  document.title = "Your idea — Basket Lab";
  $("#app").innerHTML = `<main class="idea-page"><form id="idea-form" class="idea-box"><label class="sr-only" for="idea">Your investing idea</label><textarea id="idea" maxlength="500" rows="3" placeholder="What are you thinking about?" required>${escape(state.saved?.idea ?? "")}</textarea><button id="suggest" class="submit-idea" type="submit" aria-label="Build my basket">↗</button><span id="loading" class="idea-loading" role="status" hidden>Finding companies…</span></form>${errorNode}</main>`;
}
function renderBasket(message = "") {
  document.title = "Your basket — Basket Lab";
  const rows = holdings();
  $("#app").innerHTML = header(2) + `<main class="page basket-page"><div class="page-heading"><div><p class="eyebrow">02 / YOUR BASKET</p><h1>Start together.<br><em>Keep what fits.</em></h1><p class="idea-summary">${escape(state.saved.idea)}</p></div><div class="basket-overview"><strong>${rows.length}</strong><span>companies · equal weights</span></div></div><div class="basket-toolbar"><a href="/" data-route="/" class="text-button">← Back to idea</a><div><button id="undo" class="text-button" ${state.saved.removed.length ? "" : "disabled"}>↶ Undo deletion</button><button id="export" class="secondary" ${rows.length ? "" : "disabled"}>Export ↓</button></div></div><p class="source-note">${state.saved.source === "preview" ? "Example suggestions · selected by matching business sectors. Historical prices and market events use real public observations." : "Gemini suggestions · review the companies and delete any you don't want."}</p><p id="basket-message" class="small-note" role="status">${escape(message)}</p>${errorNode}<section class="holdings-grid" aria-label="Basket companies">${rows.length ? rows.map(stock => `<article class="holding-card"><div class="holding-top"><span class="ticker-mark">${escape(stock.symbol.slice(0,3))}</span><button class="delete-button" data-remove="${escape(stock.symbol)}" aria-label="Delete ${escape(stock.symbol)}">×</button></div><strong class="holding-symbol">${escape(stock.symbol)}</strong><h2>${escape(stock.name)}</h2><p class="holding-sector">${escape(stock.sector)}</p><div class="holding-bottom"><span>YOUR BASKET SHARE</span><strong>${stock.weightPct.toFixed(2)}%</strong></div><div class="allocation-bar"><span style="width:${stock.weightPct}%"></span></div></article>`).join("") : '<div class="empty-basket"><h2>Your basket is empty.</h2><p>Undo a deletion or return to your idea to create another basket.</p></div>'}</section><div class="basket-next"><span>${rows.length ? "Total allocation 100% · weights update when you delete a company" : "Undo a deletion or create a new basket"}</span><button id="explore" class="primary" ${rows.length ? "" : "disabled"}>Explore events <span>↗</span></button></div></main>` + footer;
}
function renderEventCards() {
  const events = visibleEvents();
  $("#event-list").innerHTML = events.length ? events.map(event => `<button class="event-card ${event.id === state.eventId ? "active" : ""}" data-event="${escape(event.id)}" aria-pressed="${event.id === state.eventId}"><span class="event-card-top"><span class="provider ${event.provider}">${sourceName(event.provider)}</span><span>${event.status === "available" ? pct(event.probability)+" Yes" : "Unavailable"}</span></span><strong>${escape(event.title ?? event.label)}</strong>${event.subtitle && event.subtitle !== "Yes" ? `<span class="event-subtitle">${escape(event.subtitle)}</span>` : ""}<span class="affected">${event.linkedHoldings.map(escape).join(" · ")}</span><span class="event-connection">${escape(event.businessLink)}</span><span class="event-card-bottom"><span class="evidence ${event.fit.status === "observed" ? "observed" : ""}">${fitLabel(event.fit)}</span>${Number.isFinite(event.fit.partialR2) ? `<span>R² ${(event.fit.partialR2*100).toFixed(1)}%</span>` : ""}</span></button>`).join("") : `<p class="empty-events">No verified ${state.filter === "all" ? "prediction-market" : sourceName(state.filter)} contracts cover these holdings in this snapshot.</p>`;
  document.querySelectorAll("[data-filter]").forEach(button => { button.classList.toggle("active", button.dataset.filter === state.filter); button.setAttribute("aria-pressed", button.dataset.filter === state.filter); });
}
function chooseEvent(event) {
  state.eventId = event?.id ?? null; state.target = Number.isFinite(event?.probability) ? event.probability : null;
  if (event && !event.linkedHoldings.includes(state.stock)) state.stock = event.linkedHoldings[0];
  renderEventCards(); renderEventDetail();
}
function renderEventDetail() {
  const event = currentEvent();
  if (!event) { $("#event-detail").innerHTML = '<p class="empty-events">Choose an event to see its odds history and a what-if scenario.</p>'; renderCharts(); return; }
  const fit = event.fit, unavailable = event.status !== "available" || !Number.isFinite(event.probability);
  $("#event-detail").innerHTML = `<section class="event-detail panel"><div class="detail-heading"><div><p class="eyebrow">${sourceName(event.provider).toUpperCase()} / SELECTED EVENT</p><h2>${escape(event.title ?? event.label)}</h2>${event.subtitle && event.subtitle !== "Yes" ? `<p class="event-subtitle">${escape(event.subtitle)}</p>` : ""}</div>${event.url ? `<a class="external-link" href="${safeUrl(event.url)}" target="_blank" rel="noreferrer">View market ↗</a>` : ""}</div><p class="business-link">${escape(event.businessLink)}</p><div class="event-meta"><span>Affects ${event.linkedHoldings.map(escape).join(", ")}</span><span>${escape(event.oddsKind ?? "Yes outcome price")}</span>${event.observedAt ? `<span>Observed ${dateTime(event.observedAt)}</span>` : ""}</div>${event.stale ? '<p class="caution">Refresh failed for this market. These are previous observations, not a fresh quote.</p>' : ""}<div class="odds-chart-heading"><h3>Event odds history</h3><strong>${pct(event.probability)} Yes</strong></div><div id="odds-chart"></div>${unavailable ? `<p class="caution">${escape(event.reason ?? "This market is unavailable.")}</p>` : `<div class="slider-head"><label for="probability">What if Yes odds move to…</label><div>${pct(event.probability)} <span>→</span> <output id="target-probability">${pct(state.target)}</output></div></div><input id="probability" type="range" min="0" max="100" step="0.1" value="${state.target*100}" aria-label="Hypothetical Yes probability"><div class="range-labels"><span>0%</span><button id="reset-scenario" class="text-button">Reset to observed odds</button><span>100%</span></div><div id="scenario-output"></div>`}<details class="reliability"><summary>Data & scenario assumptions</summary><p>The dashed path illustrates odds moving gradually to your slider value over 20 US trading sessions. Broader-market movement and other events are held fixed. It extends a same-day historical relationship; it is not a validated price forecast.</p><p>Fits control for SPY and need at least 60 overlapping trading-day changes. The shaded 95% band is uncertainty in the fitted relationship, not a range of future returns. Odds changes are applied cumulatively once, never repeated as a daily shock.</p><p>Basket evidence: ${fit.n} overlapping days${fit.start ? ` (${escape(fit.start)} to ${escape(fit.end)})` : ""}. ${fit.holdout ? `Later direction ${fit.holdout.directionStable ? "consistent" : "changed"}; ${fit.holdout.n} held-out days.` : "Not enough history for a later direction check."} ${Number.isFinite(fit.qValue) ? `Multiple-event q=${fit.qValue.toFixed(3)}.` : ""} Weak evidence stays visible.</p><p>${event.provider === "kalshi" ? "Kalshi charts use observed hourly Yes bid/ask midpoints, not transaction prices. Each expiration is a separate contract." : "Polymarket charts use observed 12-hour Yes prices. Each outcome and expiration is a separate contract."} Fits only use odds known before each US close, at most 18 hours old.</p>${event.rules ? `<p>Settlement rule: ${escape(event.rules)}</p>` : ""}${event.historySource ? `<a href="${safeUrl(event.historySource)}" target="_blank" rel="noreferrer">Historical data source ↗</a>` : ""}</details></section>`;
  const history = (event.history ?? []).map(p => ({ date: new Date(p.timestamp*1000).toISOString(), close: p.price }));
  $("#odds-chart").innerHTML = chartMarkup({ id: "odds", label: `${sourceName(event.provider)} event odds history`, history, odds: true });
  if (event.historyError) {
    const notice = document.createElement("p"); notice.className = "caution";
    notice.textContent = `Some odds history could not be downloaded: ${event.historyError} Only available observations are shown.`;
    $("#odds-chart").after(notice);
  }
  if (!unavailable) updateScenario(); else renderCharts();
  bindCharts($("#odds-chart"));
}
function renderCharts() {
  const event = currentEvent(), basketHistory = state.analysis.basketHistory, stockHistory = state.analysis.stockHistories[state.stock] ?? [];
  const project = (history, fit) => event && state.target != null && event.status === "available" ? scenarioPath(history, fit, event.probability, state.target) : { points: [] };
  const basket = project(basketHistory, event?.fit), stock = project(stockHistory, event?.stockFits[state.stock]);
  $("#basket-chart").innerHTML = chartMarkup({ id: "basket", label: "Your basket historical simulation and illustrative scenario", history: basketHistory.slice(-state.range), projection: basket.points });
  $("#stock-chart").innerHTML = chartMarkup({ id: "stock", label: `${state.stock ?? "Stock"} historical performance and illustrative scenario`, history: stockHistory.slice(-state.range), projection: stock.points });
  $("#stock-select").value = state.stock ?? "";
  const chartNote = (fit, projection, hasHistory) => !hasHistory ? state.analysis.historyReason ?? "Price history unavailable." : !event ? "Choose an event to explore a future scenario." : projection.reason ?? `${fitLabel(fit)} · ${fit?.n ?? 0} overlapping days · illustrative scenario`;
  $("#basket-chart-note").textContent = chartNote(event?.fit, basket, basketHistory.length > 1);
  $("#stock-chart-note").textContent = event && !event.stockFits[state.stock] ? "No configured business link for this stock and event; no effect is assumed." : chartNote(event?.stockFits[state.stock], stock, stockHistory.length > 1);
  document.querySelectorAll("[data-range]").forEach(button => { const active = Number(button.dataset.range) === state.range; button.classList.toggle("active", active); button.setAttribute("aria-pressed", active); });
  bindCharts($("#basket-chart")); bindCharts($("#stock-chart"));
  return { basket, stock };
}
function updateScenario() {
  const event = currentEvent(); if (!event) return;
  $("#target-probability").textContent = pct(state.target);
  const { basket, stock } = renderCharts();
  const result = (label, path) => `<div><span>${escape(label)}</span><strong class="${path.estimatePct < 0 ? "negative" : "positive"}">${path.points.length ? signed(path.estimatePct) : "Unavailable"}</strong><small>${path.points.length ? `Fit interval ${signed(path.lowPct)} to ${signed(path.highPct)}` : escape(path.reason ?? "No fitted business-event relationship")}</small></div>`;
  $("#scenario-output").innerHTML = `<p class="eyebrow">ILLUSTRATIVE SCENARIO / 20 TRADING SESSIONS</p><div class="scenario-results">${result("Your basket", basket)}${result(state.stock, stock)}</div><p class="small-note">Compared with unchanged odds. Basket allocation stays fixed.</p>${[event.fit, event.stockFits[state.stock]].some(f => f && f.status !== "observed" && f.status !== "insufficient") ? '<p class="caution">Weak historical evidence. The fitted relationship may include zero or change direction in a later sample.</p>' : ""}${basket.extrapolated || stock.extrapolated ? '<p class="caution">The total odds move exceeds the largest measured daily change. This illustration extrapolates beyond the fitted evidence.</p>' : ""}`;
}
async function renderEventsPage() {
  document.title = "Events & scenarios — Basket Lab";
  $("#app").innerHTML = header(3) + `<main class="page events-page"><div class="page-heading compact"><div><p class="eyebrow">03 / EVENTS & POSSIBILITIES</p><h1>Explore what <em>could matter.</em></h1><p class="idea-summary">${escape(state.saved.idea)}</p></div><a class="secondary" href="/basket" data-route="/basket">← Edit basket</a></div>${errorNode}<div id="analysis-content"><p class="loading" role="status">Reading your basket's history and related events…</p></div></main>` + footer;
  const request = ++state.request;
  try {
    const data = state.analysis ?? await api("/api/analysis", { symbols: state.saved.symbols });
    if (request !== state.request || location.pathname !== "/events") return;
    state.analysis = data;
    if (!state.saved.symbols.includes(state.stock)) state.stock = state.saved.symbols[0];
    $("#analysis-content").innerHTML = `<div class="analysis-toolbar"><div class="provider-summary">${["polymarket", "kalshi"].map(p => `<span><i class="${p}"></i>${sourceName(p)} · ${data.providerStatus[p].available} events${data.providerStatus[p].stale ? " · previous data" : ""}</span>`).join("")}</div><div><span class="snapshot">Snapshot ${dateTime(data.builtAt)}</span><button id="refresh" class="text-button">Refresh ↻</button></div></div><div class="analysis-layout"><aside class="events-sidebar"><div class="filter-tabs" aria-label="Event provider">${["all", "polymarket", "kalshi"].map(p => `<button data-filter="${p}" aria-pressed="${state.filter === p}">${p === "all" ? "All" : sourceName(p)}</button>`).join("")}</div><nav id="event-list" class="event-list" aria-label="Related events"></nav></aside><div class="analysis-main"><div class="chart-toolbar"><span>Performance index · shared history starts at 100</span><div class="range-tabs" aria-label="Historical chart range"><button data-range="21">1M</button><button data-range="63">3M</button><button data-range="252">1Y</button></div></div><div class="performance-charts"><section class="panel performance-panel"><div class="chart-heading"><div><p class="eyebrow">YOUR ETF-STYLE BASKET</p><h2>Basket history</h2></div><span class="count">${data.holdings.length} stocks</span></div><div id="basket-chart"></div><p class="chart-caption">Simulation of today's holdings · daily equal weights</p><p id="basket-chart-note" class="evidence-note"></p></section><section class="panel performance-panel"><div class="chart-heading"><div><p class="eyebrow">ONE COMPANY</p><h2>Stock history</h2></div><select id="stock-select" aria-label="Selected stock">${data.holdings.map(s => `<option value="${escape(s.symbol)}">${escape(s.symbol)}</option>`).join("")}</select></div><div id="stock-chart"></div><p class="chart-caption">Adjusted-price performance · same historical period</p><p id="stock-chart-note" class="evidence-note"></p></section></div><div class="chart-legend"><span><i></i>Observed history</span><span><i class="dashed"></i>Illustrative scenario</span><span><i class="band"></i>Fit uncertainty</span></div><div id="event-detail"></div><p class="analysis-footnote">These curves illustrate a single event with other conditions held fixed; they are not validated forecasts.</p></div></div>`;
    chooseEvent(visibleEvents().find(e => e.id === state.eventId) ?? visibleEvents().find(e => e.status === "available") ?? visibleEvents()[0]);
  } catch (err) { if (request === state.request) { error(err.message); $("#analysis-content").innerHTML = '<p class="loading">Could not load analysis. <button id="retry" class="text-button">Try again</button></p>'; } }
}
async function renderPage() {
  state.request++;
  if (location.pathname !== "/" && !state.saved?.symbols.length) history.replaceState({}, "", "/");
  if (location.pathname === "/basket") renderBasket(); else if (location.pathname === "/events") await renderEventsPage(); else renderIdea();
}
document.addEventListener("submit", async event => {
  if (event.target.id !== "idea-form") return;
  event.preventDefault(); if (state.busy) return;
  const idea = $("#idea").value.trim(); if (!idea) { error("Enter an idea to create your basket."); return; }
  state.busy = true; error(); $("#suggest").disabled = true; $("#idea").disabled = true; $("#loading").hidden = false;
  try {
    const result = await api("/api/stocks", { idea });
    state.saved = createBasket(idea, result, state.overview.stocks.map(s => s.symbol));
    state.analysis = null; state.eventId = null; state.filter = "all"; save(); navigate("/basket");
  } catch (err) { error(err.message); }
  finally { state.busy = false; if ($("#suggest")) { $("#suggest").disabled = false; $("#idea").disabled = false; $("#loading").hidden = true; } }
});
document.addEventListener("click", async event => {
  const route = event.target.closest("[data-route]");
  if (route && !event.metaKey && !event.ctrlKey && !event.shiftKey && event.button === 0) { event.preventDefault(); navigate(route.dataset.route); return; }
  const button = event.target.closest("button"); if (!button || button.disabled) return;
  if (button.dataset.remove) { state.saved = deleteHolding(state.saved, button.dataset.remove); state.analysis = null; save(); renderBasket(`${button.dataset.remove} deleted. Remaining weights updated.`); }
  if (button.id === "undo") { const symbol = state.saved.removed.at(-1)?.symbol; state.saved = undoDeletion(state.saved); state.analysis = null; save(); renderBasket(`${symbol} restored.`); }
  if (button.id === "explore") navigate("/events");
  if (button.dataset.event) chooseEvent(state.analysis.events.find(e => e.id === button.dataset.event));
  if (button.dataset.filter) { state.filter = button.dataset.filter; chooseEvent(visibleEvents().find(e => e.id === state.eventId) ?? visibleEvents().find(e => e.status === "available") ?? visibleEvents()[0]); }
  if (button.dataset.range) { state.range = Number(button.dataset.range); renderCharts(); }
  if (button.id === "reset-scenario") { state.target = currentEvent().probability; $("#probability").value = state.target*100; updateScenario(); }
  if (button.id === "retry") await renderEventsPage();
  if (button.id === "refresh") {
    button.disabled = true; button.textContent = "Refreshing…"; error();
    try { await api("/api/refresh", {}); state.analysis = null; if (location.pathname === "/events") await renderEventsPage(); }
    catch (err) { error(err.message); button.disabled = false; button.textContent = "Refresh ↻"; }
  }
  if (button.id === "export") {
    const data = { idea: state.saved.idea, suggestedBy: state.saved.source, weightingMethod: "equal", holdings: holdings(), note: "Paper basket. Event scenarios do not change allocations.", exportedAt: new Date().toISOString() };
    const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "my-basket.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
document.addEventListener("input", event => { if (event.target.id === "probability") { state.target = Number(event.target.value)/100; updateScenario(); } });
document.addEventListener("change", event => { if (event.target.id === "stock-select") { state.stock = event.target.value; currentEvent() && $("#scenario-output") ? updateScenario() : renderCharts(); } });
window.addEventListener("popstate", () => { void renderPage(); });
try {
  state.overview = await api("/api/overview");
  try { state.saved = restoreBasket(sessionStorage.getItem(SESSION_KEY), state.overview.stocks.map(s => s.symbol)); } catch { /* memory-only flow */ }
  await renderPage();
} catch (err) { renderIdea(); error(err.message); }
