import "../lab-own/bridge.js";
import { scenarioPath } from "./math.js";
import { SESSION_KEY, AGENT_SESSION_KEY, restoreAgentSession, validPreferences, createBasket, restoreBasket, deleteHolding, undoDeletion,
  parseAmountCents, formatUsdCents, changePaperAmount, paperHoldings, exportBasket } from "./session.js";
import { escape, chartMarkup, bindCharts } from "./charts.js";

const $ = selector => document.querySelector(selector);
const pct = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "Unavailable";
const signed = value => `${value >= 0 ? "+" : ""}${Math.abs(value) < .005 ? "0.00" : value.toFixed(2)}%`;
const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const signedMoney = value => `${value < -.005 ? "−" : "+"}${money(Math.abs(value) < .005 ? 0 : Math.abs(value))}`;
const sourceName = provider => provider === "kalshi" ? "Kalshi" : "Polymarket";
const safeUrl = value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? escape(url.href) : "#"; } catch { return "#"; } };
const dateTime = value => value ? new Date(value).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" }) + " ET" : "Unavailable";
const fitLabel = fit => fit?.status === "observed" ? "Observed association" : fit?.status === "insufficient" || !fit ? "Not enough history" : "Weak evidence";
let agentSession;
try { agentSession = restoreAgentSession(sessionStorage.getItem(AGENT_SESSION_KEY)); } catch { /* memory-only browser */ }
agentSession ??= { id: crypto.randomUUID(), preferences: [], draft: null };
const state = { overview: null, saved: null, analysis: null, eventId: null, eventOpen: true, target: null, range: 63, request: 0, busy: false,
  preferences: agentSession.preferences, draft: agentSession.draft, clarification: null };
const sessionId = agentSession.id;
const iconPaths = {
  back: 'M19 12H5 M12 19l-7-7 7-7',
  right: 'M5 12h14 M12 5l7 7-7 7',
  down: 'M12 5v14 M5 12l7 7 7-7',
  external: 'M7 17 17 7 M7 7h10v10',
  undo: 'M3 10h8 M3 10V3 M3 10a8 8 0 1 1 2 8',
  refresh: 'M20 7a8 8 0 0 0-13-2L3 9 M3 3v6h6 M4 17a8 8 0 0 0 13 2l4-4 M21 21v-6h-6',
  download: 'M12 3v12 M7 10l5 5 5-5 M5 16v5h14v-5',
  plus: 'M12 5v14 M5 12h14',
  minus: 'M5 12h14',
  close: 'M6 6l12 12 M6 18 18 6',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
};
const icon = name => `<svg class="icon" viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="${iconPaths[name]}"/></svg>`;
const arrow = icon("external");
const errorNode = '<p id="error" class="error" role="alert" hidden></p>';
const brand = `<span class="brandmark" aria-hidden="true">m${arrow}</span><span>MyETF <b>Lab</b></span>`;
const paperAmount = () => (state.saved?.paperAmountCents ?? 0) / 100;
const holdings = () => paperHoldings(state.saved, state.overview.stocks);
const currentEvent = () => state.analysis?.events.find(e => e.id === state.eventId);
const subtitle = event => {
  const value = event?.subtitle?.trim();
  return value && value !== "Yes" && !(event.title ?? event.label ?? "").toLowerCase().includes(value.toLowerCase()) ? value : "";
};
const eventName = event => `${event.title ?? event.label}${subtitle(event) ? ` — ${subtitle(event)}` : ""}`;

async function api(path, body) {
  const response = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": sessionId }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error?.message ?? "The request failed."),
    { code: result.error?.code, options: result.error?.options, preferences: result.error?.preferences });
  return result;
}
function error(message = "") { const node = $("#error"); if (node) { node.hidden = !message; node.textContent = message; } }
function save() { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.saved)); } catch { error("This browser cannot save the basket across refreshes. You can still explore it here."); } }
function saveAgentSession() {
  try { sessionStorage.setItem(AGENT_SESSION_KEY, JSON.stringify({ id: sessionId, preferences: state.preferences, draft: state.draft })); }
  catch { /* Preferences stay usable until the page reloads. */ }
}
function retainPreferences(preferences) { if (validPreferences(preferences)) { state.preferences = preferences; saveAgentSession(); } }
function renderPreferences() {
  const node = $("#preferences"); if (!node) return;
  const open = node.querySelector("details")?.open;
  node.hidden = !state.preferences.length;
  node.innerHTML = state.preferences.length ? `<details ${open ? "open" : ""}><summary>Preferences</summary><ul>${state.preferences.map((p,i) =>
    `<li><span>${escape(p)}</span><button type="button" data-forget="${i}" class="delete-button" aria-label="Remove preference: ${escape(p)}">${icon("close")}</button></li>`).join("")}</ul></details>` : "";
}
function renderClarification() {
  const node = $("#clarification"); if (!node) return;
  node.hidden = !state.clarification;
  node.innerHTML = state.clarification ? `<p id="clarification-question">${escape(state.clarification.question)}</p><div>${state.clarification.options.map(option =>
    `<button type="button" class="secondary" data-clarify="${escape(option)}">${escape(option)}</button>`).join("")}</div>` : "";
}
function header(step) {
  return `<header class="topbar"><a class="brand" href="/lab" data-route="/lab" aria-label="MyETF Lab home">${brand}</a>
    <nav class="steps" aria-label="Your basket journey">${[["Idea", "/lab"], ["Basket", "/lab/basket"]].map(([name, path], i) => {
      const disabled = i === 1 && !state.saved;
      return disabled ? `<span>${name}</span>` : `<a href="${path}" data-route="${path}" ${step === i+1 ? 'aria-current="step"' : ""}>${name}</a>`;
    }).join("")}</nav></header>`;
}
function navigate(path) {
  history.pushState({}, "", path); void renderPage(); window.scrollTo(0, 0);
}
function scrollToOutlook() {
  const heading = $("#outlook-title");
  if (!heading) return;
  heading.focus({ preventScroll: true });
  $("#outlook").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
}
function resizeIdea() {
  const input = $("#idea"); if (!input) return;
  input.style.height = "auto";
  input.style.height = `${Math.min(230, Math.max(86, input.scrollHeight))}px`;
}
function renderIdea() {
  document.title = "Your idea — MyETF Lab";
  $("#app").innerHTML = `<main class="idea-page"><section class="chat-card glass" aria-labelledby="home-title">
    <div class="chat-header"><div class="home-brand">${brand}</div><h1 id="home-title">What would you like<br>to invest in?</h1></div>
    <form id="idea-form"><div class="chat-input-area"><label class="sr-only" for="idea">Your investing idea</label>
      <textarea id="idea" maxlength="500" rows="2" placeholder="Your investing idea…" aria-describedby="input-hint" required ${state.busy ? "disabled" : ""}>${escape(state.draft ?? state.saved?.idea ?? "")}</textarea>
      <button id="suggest" class="primary" type="submit" ${state.busy || !state.overview ? "disabled" : ""}>Send ${arrow}</button></div>
      <div class="chat-foot"><span id="loading" role="status" ${state.busy ? "" : "hidden"}>Finding your companies…</span><span id="input-hint" class="sr-only">Enter to send. Shift + Enter for a new line.</span></div></form>
    <section id="clarification" class="clarification" aria-labelledby="clarification-question" aria-live="polite" hidden></section>
    <div id="preferences" class="preferences" hidden></div>${errorNode}</section></main>`;
  resizeIdea(); renderClarification(); renderPreferences();
}
function amountDialog() {
  return `<dialog id="amount-dialog" class="amount-dialog" aria-labelledby="amount-title"><form id="amount-form" novalidate>
    <h2 id="amount-title"></h2><p id="amount-note" class="muted"></p>
    <label class="amount-label" for="amount">Amount in USD</label><div class="amount-input"><span aria-hidden="true">$</span>
      <input id="amount" name="amount" type="text" inputmode="decimal" maxlength="22" placeholder="0.00" aria-describedby="amount-note amount-error" autocomplete="off" required></div>
    <p id="amount-preview" class="small-note" aria-live="polite"></p><p id="amount-error" class="error" role="alert" hidden></p>
    <div class="dialog-actions"><button id="cancel-amount" class="secondary" type="button">Cancel</button><button id="confirm-amount" class="primary" type="submit"></button></div>
  </form></dialog>`;
}
function renderBasket(message = "") {
  document.title = "Your basket — MyETF Lab";
  const rows = holdings(), amount = state.saved.paperAmountCents;
  $("#app").innerHTML = header(2) + `<main class="page basket-page"><div class="page-heading"><div><h1>Your basket</h1><span class="source-badge">${state.saved.source === "preview" ? "Example basket" : "Gemini basket"}</span></div><a href="/lab" data-route="/lab" class="text-button" aria-label="Back to idea">${icon("back")}Back</a></div>
    <section class="funding-panel glass" aria-label="Paper amount"><div><span class="funding-label">${rows.length ? "Paper funds" : "Unallocated paper funds"}</span><strong class="paper-total">${formatUsdCents(amount)}</strong></div>
      <div class="fund-actions"><button id="buy" class="primary" ${rows.length ? "" : "disabled"}>${icon("plus")}Buy</button><button id="sell" class="secondary" ${amount > 0 ? "" : "disabled"}>${icon("minus")}Sell</button></div></section>
    <div class="basket-toolbar"><button id="undo" class="text-button" ${state.saved.removed.length ? "" : "disabled"}>${icon("undo")}Undo</button><button id="export" class="text-button" ${rows.length || amount > 0 ? "" : "disabled"}>${icon("download")}Export</button></div>
    <p id="basket-message" class="small-note" role="status" ${message ? "" : "hidden"}>${escape(message)}</p>${errorNode}
    <section class="holdings-panel glass" aria-label="Basket companies"><div class="holdings-labels" aria-hidden="true"><span>Company</span><span>Sector</span><span>Weight</span><span>Allocation</span><span></span></div>
      ${rows.length ? rows.map(stock => `<article class="holding-row"><div class="holding-company"><div><h2>${escape(stock.name)}</h2><span class="holding-symbol">${escape(stock.symbol)}</span></div></div>
        <span class="holding-sector">${escape(stock.sector)}</span><span class="holding-weight"><span class="sr-only">Weight </span>${stock.weightPct.toFixed(2)}%</span>
        <strong class="holding-dollars"><span class="sr-only">Paper allocation </span>${formatUsdCents(stock.allocatedCents)}</strong><button class="delete-button" data-remove="${escape(stock.symbol)}" aria-label="Delete ${escape(stock.symbol)}">${icon("close")}</button></article>`).join("") : '<div class="empty-basket"><h2>Your basket is empty.</h2><p>Undo a deletion to restore it.</p></div>'}
    </section><div class="basket-next"><button id="explore" class="secondary" ${rows.length ? "" : "disabled"}>Events to watch ${icon("down")}</button></div>
    <section id="outlook" class="outlook-section" aria-labelledby="outlook-title"><div class="outlook-heading"><h2 id="outlook-title" tabindex="-1">What could move your ETF?</h2></div>
      <p id="analysis-error" class="error" role="alert" hidden></p><div id="analysis-content">${rows.length ? '<p class="loading" role="status">Finding events connected to your companies…</p>' : '<p class="empty-events glass">Restore a company to see what could affect your basket.</p>'}</div>
    </section></main>` + amountDialog();
  const request = ++state.request;
  if (rows.length) void loadOutlook(request);
}
function openAmountDialog(mode) {
  const dialog = $("#amount-dialog"); dialog.dataset.mode = mode;
  $("#amount-title").textContent = mode === "buy" ? "Buy your basket." : "Sell an amount.";
  $("#amount-note").textContent = mode === "buy" ? "Add paper funds and split them equally across your companies." : `You have ${formatUsdCents(state.saved.paperAmountCents)} in paper funds. Sell part or all of it.`;
  $("#confirm-amount").textContent = mode === "buy" ? "Confirm paper buy" : "Confirm paper sale";
  $("#amount").value = ""; $("#amount").removeAttribute("aria-invalid"); $("#amount-error").hidden = true; $("#amount-preview").textContent = "";
  dialog.showModal(); $("#amount").focus();
}
function previewAmount() {
  $("#amount-error").hidden = true; $("#amount").removeAttribute("aria-invalid");
  try {
    const next = changePaperAmount(state.saved, $("#amount-dialog").dataset.mode, parseAmountCents($("#amount").value));
    $("#amount-preview").textContent = `Paper amount after ${$("#amount-dialog").dataset.mode === "buy" ? "buying" : "selling"}: ${formatUsdCents(next.paperAmountCents)}`;
  } catch { $("#amount-preview").textContent = ""; }
}
function chooseEvent(event) {
  if (event?.id === state.eventId) state.eventOpen = !state.eventOpen;
  else {
    state.eventId = event?.id ?? null; state.eventOpen = true;
    state.target = Number.isFinite(event?.probability) ? event.probability : null;
  }
  renderEventDetail();
}
function renderEventDetail() {
  const event = currentEvent(), available = event?.status === "available" && Number.isFinite(event.probability);
  const selected = [...document.querySelectorAll("[data-event]")].find(button => button.dataset.event === event?.id);
  if (!selected) return;
  document.querySelectorAll("[data-event]").forEach(button => {
    const active = button === selected && state.eventOpen;
    button.setAttribute("aria-expanded", active);
    button.closest(".event-post").classList.toggle("selected", active);
    button.querySelector(".event-action").innerHTML = active ? `Close scenario ${icon("chevronUp")}` : `Explore impact ${icon("chevronDown")}`;
  });
  const panel = $("#scenario-panel");
  selected.closest(".event-post").append(panel); panel.hidden = !state.eventOpen;
  if (!state.eventOpen) return;
  $("#scenario-controls").innerHTML = `<div class="scenario-heading"><h2>Next 20 trading days</h2></div>
    <div class="scenario-numbers"><div class="probability-comparison ${Number.isFinite(event?.probability) ? "" : "unavailable-odds"}"><div><span>Market odds</span><strong>${pct(event?.probability)}</strong></div><span class="probability-arrow" aria-hidden="true">${icon("right")}</span><div><label for="probability">Your odds</label><output id="target-probability" for="probability">${pct(state.target)}</output></div></div>
      <div id="scenario-output" class="basket-effect" aria-live="polite"></div></div>
    <input id="probability" type="range" min="0" max="100" step="0.1" value="${(state.target ?? 0)*100}" aria-label="Hypothetical Yes probability" ${available ? "" : "disabled"}>
    <div class="range-labels"><span>0%</span><button id="reset-scenario" class="reset-button" aria-label="Reset to observed odds" ${available ? "" : "disabled"}>${icon("undo")}Reset</button><span>100%</span></div><p id="scenario-note" class="scenario-note"></p>`;
  $("#event-detail").innerHTML = `<details class="reliability"><summary>How this is calculated</summary>
        ${event.stale ? '<p class="caution">Previous observations · the latest refresh failed for this event.</p>' : ""}
        ${event.historyError ? `<p class="caution">Some underlying odds observations could not be downloaded: ${escape(event.historyError)}</p>` : ""}
        <p>${sourceName(event.provider)} · Affects ${event.linkedHoldings.map(escape).join(", ")}. ${escape(event.oddsKind ?? "Yes outcome price")}. Observed ${dateTime(event.observedAt)}.</p>
        <p>Contract ${escape(event.marketId ?? "unavailable")}${event.endDate ? ` · closes ${dateTime(event.endDate)}` : ""}.</p>
        ${event.weeklyMove ? `<p>Yes odds changed ${(event.weeklyMove.change*100).toFixed(1)} percentage points over the seven-day comparison. Reference: ${dateTime(event.weeklyMove.from*1000)}; observed quote: ${dateTime(event.weeklyMove.to*1000)}. This is an odds change, not a stock return.</p>` : ""}
        <p>Basket history simulates today's holdings using daily equal weights and adjusted prices, indexed to 100 at the start. It is not an actual historical ETF.</p><p id="fit-interval"></p>
        <p>Basket evidence: ${event.fit.n} overlapping days${event.fit.start ? ` (${escape(event.fit.start)} to ${escape(event.fit.end)})` : ""}. ${Number.isFinite(event.fit.partialR2) ? `Partial R² ${(event.fit.partialR2*100).toFixed(1)}%.` : ""} ${event.fit.holdout ? `Later direction ${event.fit.holdout.directionStable ? "consistent" : "changed"}; ${event.fit.holdout.n} held-out days.` : "Not enough history for a later direction check."} ${Number.isFinite(event.fit.qValue) ? `Multiple-event q=${event.fit.qValue.toFixed(3)}.` : ""}</p>
        <p>Odds move gradually to your slider value over 20 scheduled US trading sessions. The cumulative effect is applied once, with broader-market movement and other events held fixed. Fits control for SPY, need 60 varying overlapping changes and only use odds known before the equity close, at most 18 hours old.</p>
        <p>The shaded 95% band reflects uncertainty in the fitted relationship, not future-return uncertainty. This is an illustrative scenario, not a validated forecast. Dollar effects use your paper funding amount; they do not record gains or sales.</p>
        <p>${event.provider === "kalshi" ? "Kalshi uses observed hourly Yes bid/ask midpoints." : "Polymarket uses observed 12-hour Yes prices."} Outcomes and expirations remain separate.</p>
        ${event.rules ? `<p>Settlement rule: ${escape(event.rules)}</p>` : ""}${event.historySource ? `<a href="${safeUrl(event.historySource)}" target="_blank" rel="noreferrer">Historical data source ${arrow}</a>` : ""}
      </details>`;
  updateScenario();
}
function updateScenario() {
  const event = currentEvent(), history = state.analysis.basketHistory;
  const available = event?.status === "available" && state.target != null;
  const path = available ? scenarioPath(history, event.fit, event.probability, state.target) : { points: [], reason: event?.reason ?? "Choose an available event to explore a scenario." };
  if ($("#target-probability")) $("#target-probability").textContent = pct(state.target);
  $("#probability")?.style.setProperty("--range-progress", `${(state.target ?? 0)*100}%`);
  $("#probability")?.setAttribute("aria-valuetext", `${pct(state.target)} hypothetical Yes odds`);
  if ($("#scenario-output")) $("#scenario-output").innerHTML = `<span>Illustrative change</span><strong class="${path.estimatePct < 0 ? "negative" : "positive"}">${path.points.length ? signed(path.estimatePct) : "Unavailable"}</strong>
    ${path.points.length && paperAmount() > 0 ? `<small>${signedMoney(paperAmount()*path.estimatePct/100)}</small>` : ""}`;
  $("#scenario-output")?.classList.toggle("is-unavailable", !path.points.length);
  if ($("#scenario-note")) $("#scenario-note").textContent = path.points.length ? `${fitLabel(event.fit)}${path.extrapolated ? " · Beyond observed odds moves" : ""}` : path.reason;
  $("#basket-chart").innerHTML = chartMarkup({ id: "basket", label: "Your basket historical simulation and illustrative scenario", history: history.slice(-state.range), projection: path.points });
  $("#basket-chart-note").hidden = history.length >= 2;
  $("#basket-chart-note").textContent = state.analysis.historyReason ?? "Basket price history is unavailable.";
  if ($("#fit-interval")) $("#fit-interval").textContent = path.points.length ? `95% fit interval: ${signed(path.lowPct)} to ${signed(path.highPct)}` : "A future illustration needs enough overlapping observations.";
  document.querySelectorAll("[data-range]").forEach(button => { const active = Number(button.dataset.range) === state.range; button.classList.toggle("active", active); button.setAttribute("aria-pressed", active); });
  bindCharts($("#basket-chart"));
}
function basketChartShell() {
  return `<div class="basket-chart-heading"><h2>Basket simulation</h2><div class="range-tabs" aria-label="Historical chart range">${[[21,"1M"],[63,"3M"],[252,"1Y"]].map(([n,label]) => `<button data-range="${n}">${label}</button>`).join("")}</div></div><div id="basket-chart"></div><div class="chart-legend"><span><i></i>History</span><span><i class="dashed"></i>Scenario</span><span><i class="band"></i>Fit uncertainty</span></div><p id="basket-chart-note" class="chart-caption" role="status"></p>`;
}
async function loadOutlook(request) {
  try {
    const data = state.analysis ?? await api("/api/lab/analysis", { symbols: state.saved.symbols });
    if (request !== state.request || location.pathname !== "/lab/basket") return;
    state.analysis = data;
    const selected = data.events.find(e => e.id === state.eventId) ?? data.events.find(e => e.status === "available") ?? data.events[0];
    if (selected?.id !== state.eventId) state.eventOpen = true;
    if (selected?.id !== state.eventId || !Number.isFinite(state.target)) state.target = Number.isFinite(selected?.probability) ? selected.probability : null;
    state.eventId = selected?.id ?? null;
    $("#analysis-content").innerHTML = `<div class="event-feed" aria-label="Events that could affect your ETF">${data.events.map((event, i) => `<article class="event-post glass" aria-labelledby="event-title-${i}">
        <div class="event-post-heading"><div><span class="event-source">${sourceName(event.provider)}${event.url ? `<a href="${safeUrl(event.url)}" target="_blank" rel="noreferrer" aria-label="View ${escape(eventName(event))} on ${sourceName(event.provider)}">${arrow}</a>` : ""}</span>
          ${event.weeklyMove ? `<span class="event-weekly" aria-label="Yes odds changed ${(event.weeklyMove.change*100).toFixed(1)} percentage points in seven days">${Math.abs(event.weeklyMove.change*100) < .05 ? "Flat" : `${event.weeklyMove.change > 0 ? "+" : "−"}${Math.abs(event.weeklyMove.change*100).toFixed(1)} pts`} · 7 days</span>` : ""}</div><span class="event-odds ${event.status === "available" ? "" : "unavailable"}">${event.status === "available" ? pct(event.probability) : "Unavailable"}<small>Observed Yes odds</small></span></div>
        <button class="event-story" data-event="${escape(event.id)}" aria-expanded="false" aria-controls="scenario-panel"><span class="event-headline" id="event-title-${i}">${escape(eventName(event))}</span><span class="event-connection">${escape(event.businessLink)}</span><span class="event-holdings"><span>Affects</span>${event.linkedHoldings.map(symbol => `<span class="holding-chip">${escape(symbol)}</span>`).join("")}</span><span class="event-story-footer"><span class="event-action">Explore impact ${icon("chevronDown")}</span></span></button>
      </article>`).join("")}</div>
      <section id="scenario-panel" class="scenario-panel thread-reply" aria-label="Selected event basket scenario" hidden><div id="scenario-controls"></div>${basketChartShell()}<div id="event-detail"></div></section>
      ${data.events.length ? "" : '<p class="empty-events glass">No verified events cover this basket in the current snapshot.</p>'}<div class="snapshot-bar"><details class="data-info"><summary>Data sources</summary><p>Snapshot: ${dateTime(data.builtAt)}. Prices and event odds use observed public data. Events represent prediction-market contracts.</p></details><button id="refresh" class="text-button">${icon("refresh")}Refresh</button></div>`;
    if (selected) renderEventDetail();
    else {
      const panel = $("#scenario-panel"); panel.hidden = false; panel.classList.add("glass");
      $("#scenario-controls").hidden = true;
      $("#scenario-panel .chart-legend").innerHTML = '<span><i></i>History</span>';
      $("#event-detail").innerHTML = '<details class="reliability"><summary>How this is calculated</summary><p>Basket history simulates today’s holdings using daily equal weights and adjusted prices, indexed to 100 at the start.</p><p id="fit-interval"></p></details>';
      updateScenario();
    }
  } catch (err) {
    if (request === state.request && location.pathname === "/lab/basket") {
      $("#analysis-error").hidden = false; $("#analysis-error").textContent = err.message;
      $("#analysis-content").innerHTML = '<p class="loading">Could not load the event feed. <button id="retry" class="text-button">Try again</button></p>';
    }
  }
}
async function reloadOutlook() {
  $("#analysis-error").hidden = true;
  $("#analysis-content").innerHTML = '<p class="loading" role="status">Finding events connected to your companies…</p>';
  await loadOutlook(++state.request);
}
async function renderPage() {
  state.request++;
  // Keep old bookmarks working: scenarios now live beneath the basket.
  if (location.pathname === "/lab/events") history.replaceState({}, "", state.saved?.symbols.length ? "/lab/basket#outlook" : "/lab");
  // A saved empty basket remains editable and its unallocated paper funds stay accessible.
  if (location.pathname === "/lab/basket" && !state.saved) history.replaceState({}, "", "/lab");
  if (location.pathname === "/lab/basket") { renderBasket(); if (location.hash === "#outlook") scrollToOutlook(); } else renderIdea();
}
document.addEventListener("submit", async event => {
  if (event.target.id === "amount-form") {
    event.preventDefault();
    const mode = $("#amount-dialog").dataset.mode;
    try {
      const amount = parseAmountCents($("#amount").value);
      const next = changePaperAmount(state.saved, mode, amount);
      $("#amount-dialog").close(); state.saved = next;
      renderBasket(`${mode === "buy" ? "Added" : "Sold"} ${formatUsdCents(amount)} in paper funds.`); save();
      const focusTarget = [$(`#${mode}`), $("#buy"), $("#undo")].find(button => button && !button.disabled);
      (focusTarget ?? $("[data-route]"))?.focus();
    } catch (err) { $("#amount-error").textContent = err.message; $("#amount-error").hidden = false; $("#amount").setAttribute("aria-invalid", "true"); $("#amount").focus(); }
    return;
  }
  if (event.target.id !== "idea-form") return;
  event.preventDefault(); if (state.busy || !state.overview) return;
  const idea = $("#idea").value.trim(); if (!idea) { error("Enter an idea to create your basket."); return; }
  state.draft = idea; state.clarification = null; renderClarification(); saveAgentSession();
  state.busy = true; error(); $("#suggest").disabled = true; $("#idea").disabled = true; $("#loading").hidden = false; $("#input-hint").hidden = true;
  try {
    const result = await api("/api/lab/stocks", { idea, preferences: state.preferences });
    const next = createBasket(idea, result, state.overview.stocks.map(s => s.symbol));
    retainPreferences(result.preferences);
    state.saved = next;
    state.analysis = null; state.eventId = null; navigate("/lab/basket"); save();
  } catch (err) {
    if (err.code === "needs_clarification" && Array.isArray(err.options) && err.options.length >= 2 && err.options.length <= 3 && err.options.every(v => typeof v === "string" && v.length <= 100)) {
      retainPreferences(err.preferences); state.clarification = { question: err.message, options: err.options }; renderClarification(); renderPreferences();
    } else error(err.message);
  }
  finally { state.busy = false; if ($("#suggest")) { $("#suggest").disabled = false; $("#idea").disabled = false; $("#loading").hidden = true; $("#input-hint").hidden = false; } }
});
document.addEventListener("click", async event => {
  const route = event.target.closest("[data-route]");
  if (route && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); navigate(route.dataset.route); return; }
  const button = event.target.closest("button"); if (!button || button.disabled) return;
  if (button.dataset.clarify && !state.busy) { $("#idea").value = button.dataset.clarify; resizeIdea(); $("#idea-form").requestSubmit(); return; }
  if (button.dataset.forget !== undefined && !state.busy) {
    state.preferences = state.preferences.filter((_,i) => i !== Number(button.dataset.forget));
    state.clarification = null; saveAgentSession(); renderPreferences(); renderClarification(); $("#idea")?.focus(); return;
  }
  if (button.dataset.event) {
    chooseEvent(state.analysis.events.find(e => e.id === button.dataset.event));
    button.closest(".event-post").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth", block: "start" });
    return;
  }
  if (button.dataset.remove) {
    const index = state.saved.symbols.indexOf(button.dataset.remove);
    state.saved = deleteHolding(state.saved, button.dataset.remove); state.analysis = null;
    renderBasket(`${button.dataset.remove} deleted. ${state.saved.symbols.length ? "Your paper funds were redistributed." : "Paper funds are preserved as unallocated funds."}`); save();
    const remaining = [...document.querySelectorAll("[data-remove]")];
    (remaining[Math.min(index, remaining.length - 1)] ?? $("#undo"))?.focus();
  }
  if (button.id === "undo") {
    const symbol = state.saved.removed.at(-1)?.symbol;
    state.saved = undoDeletion(state.saved); state.analysis = null; renderBasket(`${symbol} restored. Allocation updated.`); save();
    const restored = [...document.querySelectorAll("[data-remove]")].find(b => b.dataset.remove === symbol);
    ($("#undo").disabled ? restored : $("#undo"))?.focus();
  }
  if (["buy","sell"].includes(button.id)) openAmountDialog(button.id);
  if (button.id === "cancel-amount") $("#amount-dialog").close();
  if (button.id === "explore") scrollToOutlook();
  if (button.dataset.range) { state.range = Number(button.dataset.range); updateScenario(); }
  if (button.id === "reset-scenario") { state.target = currentEvent().probability; $("#probability").value = state.target*100; updateScenario(); }
  if (button.id === "retry") await reloadOutlook();
  if (button.id === "refresh") {
    const request = ++state.request;
    button.disabled = true; button.textContent = "Refreshing…"; $("#analysis-error").hidden = true;
    try { await api("/api/lab/refresh", {}); if (request === state.request && location.pathname === "/lab/basket") { state.analysis = null; await reloadOutlook(); } }
    catch (err) { if (button.isConnected) { $("#analysis-error").hidden = false; $("#analysis-error").textContent = err.message; button.disabled = false; button.innerHTML = `${icon("refresh")}Refresh`; } }
  }
  if (button.id === "export") {
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportBasket(state.saved, state.overview.stocks), null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "my-basket.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
document.addEventListener("input", event => {
  if (event.target.id === "probability") { state.target = Number(event.target.value)/100; updateScenario(); }
  if (event.target.id === "idea") { state.draft = event.target.value; state.clarification = null; renderClarification(); resizeIdea(); saveAgentSession(); }
  if (event.target.id === "amount") previewAmount();
});
document.addEventListener("keydown", event => {
  if ($("#amount-dialog")?.open && event.key === "Tab") {
    const controls = [$("#amount"), $("#cancel-amount"), $("#confirm-amount")];
    const index = controls.indexOf(document.activeElement);
    event.preventDefault(); controls[(index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
  }
  if (event.target.id === "idea" && event.key === "Enter" && !event.shiftKey && !event.isComposing) {
    event.preventDefault(); $("#idea-form").requestSubmit();
  }
});
window.addEventListener("popstate", () => { void renderPage(); });
window.addEventListener("resize", resizeIdea);
saveAgentSession();
try {
  state.overview = await api("/api/lab/overview");
  try { state.saved = restoreBasket(sessionStorage.getItem(SESSION_KEY), state.overview.stocks.map(s => s.symbol)); } catch { /* memory-only flow */ }
  await renderPage();
} catch (err) { renderIdea(); error(err.message); }
