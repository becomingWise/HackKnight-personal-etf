import { scenarioPath } from "./math.js";
import { SESSION_KEY, createBasket, restoreBasket, deleteHolding, undoDeletion,
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
const state = { overview: null, saved: null, analysis: null, eventId: null, eventOpen: true, target: null, range: 63, request: 0, busy: false };
const sessionId = crypto.randomUUID();
const arrow = '<span aria-hidden="true">↗</span>';
const errorNode = '<p id="error" class="error" role="alert" hidden></p>';
const brand = '<span class="brandmark" aria-hidden="true">m<span>↗</span></span><span>MyETF <b>Lab</b></span>';
const footer = '<footer><span>MyETF Lab</span><span>Paper funds · illustrative scenarios</span></footer>';
const paperAmount = () => (state.saved?.paperAmountCents ?? 0) / 100;
const holdings = () => paperHoldings(state.saved, state.overview.stocks);
const currentEvent = () => state.analysis?.events.find(e => e.id === state.eventId);
const subtitle = event => event?.subtitle && event.subtitle !== "Yes" ? event.subtitle : "";
const eventName = event => `${event.title ?? event.label}${subtitle(event) ? ` — ${subtitle(event)}` : ""}`;

async function api(path, body) {
  const response = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": sessionId }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "The request failed.");
  return result;
}
function error(message = "") { const node = $("#error"); if (node) { node.hidden = !message; node.textContent = message; } }
function save() { try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(state.saved)); } catch { error("This browser cannot save the basket across refreshes. You can still explore it here."); } }
function header(step) {
  return `<header class="topbar"><a class="brand" href="/" data-route="/" aria-label="MyETF Lab home">${brand}</a>
    <nav class="steps" aria-label="Your basket journey">${[["Idea", "/"], ["Basket", "/basket"]].map(([name, path], i) => {
      const disabled = i === 1 && !state.saved;
      return disabled ? `<span><i>${i+1}</i>${name}</span>` : `<a href="${path}" data-route="${path}" ${step === i+1 ? 'aria-current="step"' : ""}><i>${i+1}</i>${name}</a>`;
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
    <div class="chat-header"><div class="home-brand">${brand}</div><p class="eyebrow">YOUR IDEAS, YOUR BASKET</p>
      <h1 id="home-title">What would you like<br>to invest in?</h1><p>Start with a thought. We'll find the companies.</p></div>
    <form id="idea-form"><div class="chat-input-area"><label class="sr-only" for="idea">Your investing idea</label>
      <textarea id="idea" maxlength="500" rows="2" placeholder="I believe the next big thing is…" required ${state.busy ? "disabled" : ""}>${escape(state.saved?.idea ?? "")}</textarea>
      <button id="suggest" class="primary" type="submit" ${state.busy || !state.overview ? "disabled" : ""}>Send ${arrow}</button></div>
      <div class="chat-foot"><span id="loading" role="status" ${state.busy ? "" : "hidden"}>Finding your companies…</span><span id="input-hint" ${state.busy ? "hidden" : ""}>Enter to send <span aria-hidden="true">·</span> Shift + Enter for a new line</span></div></form>
    ${errorNode}</section><p class="home-note">A little curiosity. A new perspective.</p></main>`;
  resizeIdea();
}
function amountDialog() {
  return `<dialog id="amount-dialog" class="amount-dialog" aria-labelledby="amount-title"><form id="amount-form" novalidate>
    <p class="eyebrow">PAPER FUNDS</p><h2 id="amount-title"></h2><p id="amount-note" class="muted"></p>
    <label class="amount-label" for="amount">Amount in USD</label><div class="amount-input"><span aria-hidden="true">$</span>
      <input id="amount" name="amount" type="text" inputmode="decimal" maxlength="22" placeholder="0.00" aria-describedby="amount-note amount-error" autocomplete="off" required></div>
    <p id="amount-preview" class="small-note" aria-live="polite"></p><p id="amount-error" class="error" role="alert" hidden></p>
    <div class="dialog-actions"><button id="cancel-amount" class="secondary" type="button">Cancel</button><button id="confirm-amount" class="primary" type="submit"></button></div>
  </form></dialog>`;
}
function renderBasket(message = "") {
  document.title = "Your basket — MyETF Lab";
  const rows = holdings(), amount = state.saved.paperAmountCents;
  $("#app").innerHTML = header(2) + `<main class="page basket-page"><div class="page-heading"><div><p class="eyebrow">YOUR BASKET</p><h1>A basket that fits you.</h1><p class="idea-summary">${escape(state.saved.idea)}</p></div><a href="/" data-route="/" class="text-button">← Back to idea</a></div>
    <section class="funding-panel glass" aria-label="Paper amount"><div><span class="eyebrow">${rows.length ? "YOUR PAPER AMOUNT" : "UNALLOCATED PAPER FUNDS"}</span><strong class="paper-total">${formatUsdCents(amount)}</strong><p>${rows.length ? `${rows.length} companies · equally allocated` : "Restore a company to allocate these funds"}</p></div>
      <div class="fund-actions"><button id="buy" class="primary" ${rows.length ? "" : "disabled"}>Buy <span aria-hidden="true">+</span></button><button id="sell" class="secondary" ${amount > 0 ? "" : "disabled"}>Sell <span aria-hidden="true">−</span></button></div></section>
    <div class="basket-toolbar"><span>${rows.length} companies <span class="toolbar-dot">·</span> Equal weights</span><div><button id="undo" class="text-button" ${state.saved.removed.length ? "" : "disabled"}>↶ Undo deletion</button><button id="export" class="text-button" ${rows.length || amount > 0 ? "" : "disabled"}>Export ↓</button></div></div>
    <p class="source-note">${state.saved.source === "preview" ? "Example suggestions · matched to your idea. Prices and event histories use real public observations." : "Gemini suggestions · keep the companies that fit your idea."}</p>
    <p id="basket-message" class="small-note" role="status" ${message ? "" : "hidden"}>${escape(message)}</p>${errorNode}
    <section class="holdings-panel glass" aria-label="Basket companies"><div class="holdings-labels" aria-hidden="true"><span>COMPANY</span><span>SECTOR</span><span>WEIGHT</span><span>PAPER ALLOCATION</span><span></span></div>
      ${rows.length ? rows.map(stock => `<article class="holding-row"><div class="holding-company"><span class="ticker-mark" aria-hidden="true">${escape(stock.symbol.slice(0,3))}</span><div><h2>${escape(stock.name)}</h2><span class="holding-symbol">${escape(stock.symbol)}</span></div></div>
        <span class="holding-sector">${escape(stock.sector)}</span><span class="holding-weight"><span class="sr-only">Weight </span>${stock.weightPct.toFixed(2)}%</span>
        <strong class="holding-dollars"><span class="sr-only">Paper allocation </span>${formatUsdCents(stock.allocatedCents)}</strong><button class="delete-button" data-remove="${escape(stock.symbol)}" aria-label="Delete ${escape(stock.symbol)}">×</button></article>`).join("") : '<div class="empty-basket"><h2>Your basket is empty.</h2><p>Undo a deletion or return to your idea to start again.</p></div>'}
    </section><div class="basket-next"><span>${rows.length ? "100% allocated · delete a company to rebalance" : "Your paper funds are preserved"}</span><button id="explore" class="secondary" ${rows.length ? "" : "disabled"}>Events to watch <span aria-hidden="true">↓</span></button></div>
    <section id="outlook" class="outlook-section" aria-labelledby="outlook-title"><div class="outlook-heading"><p class="eyebrow">ON THE HORIZON</p><h2 id="outlook-title" tabindex="-1">What could move your ETF?</h2><p>Follow the possibilities. Explore what changing odds could mean for your basket.</p></div>
      <p id="analysis-error" class="error" role="alert" hidden></p><div id="analysis-content">${rows.length ? '<p class="loading" role="status">Finding events connected to your companies…</p>' : '<p class="empty-events glass">Restore a company to see what could affect your basket.</p>'}</div>
    </section></main>` + footer + amountDialog();
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
    button.querySelector(".event-action").textContent = active ? "Close scenario ↑" : "Explore basket impact →";
  });
  const panel = $("#scenario-panel");
  selected.closest(".event-post").append(panel); panel.hidden = !state.eventOpen;
  if (!state.eventOpen) return;
  $("#scenario-controls").innerHTML = `<div class="scenario-heading"><div><p class="eyebrow">WHAT IF THE ODDS CHANGE?</p><h2>Move the odds. Explore your basket.</h2></div><span class="session-pill">20 trading sessions</span></div>
    <div class="scenario-numbers"><div class="probability-comparison ${Number.isFinite(event?.probability) ? "" : "unavailable-odds"}"><div><span>Observed Yes odds</span><strong>${pct(event?.probability)}</strong></div><span class="probability-arrow" aria-hidden="true">→</span><div><label for="probability">Your scenario</label><output id="target-probability" for="probability">${pct(state.target)}</output></div></div>
      <div id="scenario-output" class="basket-effect" aria-live="polite"></div></div>
    <input id="probability" type="range" min="0" max="100" step="0.1" value="${(state.target ?? 0)*100}" aria-label="Hypothetical Yes probability" ${available ? "" : "disabled"}>
    <div class="range-labels"><span>0%</span><button id="reset-scenario" class="reset-button" ${available ? "" : "disabled"}>↶ Reset to observed</button><span>100%</span></div><p id="scenario-note" class="scenario-note"></p>`;
  $("#event-detail").innerHTML = `<details class="reliability"><summary>Evidence & scenario assumptions</summary>
        ${event.stale ? '<p class="caution">Previous observations · the latest refresh failed for this event.</p>' : ""}
        ${event.historyError ? `<p class="caution">Some underlying odds observations could not be downloaded: ${escape(event.historyError)}</p>` : ""}
        <p>${sourceName(event.provider)} · Affects ${event.linkedHoldings.map(escape).join(", ")}. ${escape(event.oddsKind ?? "Yes outcome price")}. Observed ${dateTime(event.observedAt)}.</p>
        <p>Contract ${escape(event.marketId ?? "unavailable")}${event.endDate ? ` · closes ${dateTime(event.endDate)}` : ""}.</p>
        <p>Basket evidence: ${event.fit.n} overlapping days${event.fit.start ? ` (${escape(event.fit.start)} to ${escape(event.fit.end)})` : ""}. ${Number.isFinite(event.fit.partialR2) ? `Partial R² ${(event.fit.partialR2*100).toFixed(1)}%.` : ""} ${event.fit.holdout ? `Later direction ${event.fit.holdout.directionStable ? "consistent" : "changed"}; ${event.fit.holdout.n} held-out days.` : "Not enough history for a later direction check."} ${Number.isFinite(event.fit.qValue) ? `Multiple-event q=${event.fit.qValue.toFixed(3)}.` : ""}</p>
        <p>Odds move gradually to your slider value over 20 scheduled US trading sessions. The cumulative effect is applied once, with broader-market movement and other events held fixed. Fits control for SPY, need 60 varying overlapping changes and only use odds known before the equity close, at most 18 hours old.</p>
        <p>The shaded 95% band reflects uncertainty in the fitted relationship, not future-return uncertainty. This is an illustrative scenario, not a validated forecast. Dollar effects use your paper funding amount; they do not record gains or sales.</p>
        <p>${event.provider === "kalshi" ? "Kalshi uses observed hourly Yes bid/ask midpoints." : "Polymarket uses observed 12-hour Yes prices."} Outcomes and expirations remain separate.</p>
        ${event.rules ? `<p>Settlement rule: ${escape(event.rules)}</p>` : ""}${event.historySource ? `<a href="${safeUrl(event.historySource)}" target="_blank" rel="noreferrer">Historical data source ↗</a>` : ""}
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
  if ($("#scenario-output")) $("#scenario-output").innerHTML = `<span>Illustrative basket change</span><strong class="${path.estimatePct < 0 ? "negative" : "positive"}">${path.points.length ? signed(path.estimatePct) : "Unavailable"}</strong>
    <small>${path.points.length && paperAmount() > 0 ? `${signedMoney(paperAmount()*path.estimatePct/100)} on ${formatUsdCents(state.saved.paperAmountCents)} in paper funds` : "Compared with unchanged odds"}</small>`;
  if ($("#scenario-note")) $("#scenario-note").textContent = path.points.length ? `${fitLabel(event.fit)} · ${event.fit.n} overlapping days${path.extrapolated ? " · This odds move exceeds the largest observed daily change." : ""}` : path.reason;
  $("#basket-chart").innerHTML = chartMarkup({ id: "basket", label: "Your basket historical simulation and illustrative scenario", history: history.slice(-state.range), projection: path.points });
  $("#basket-chart-note").textContent = history.length < 2 ? state.analysis.historyReason ?? "Basket price history is unavailable." : "Simulation of today's holdings · daily equal weights · index starts at 100";
  $("#fit-interval").textContent = path.points.length ? `Illustrative scenario · 95% fit interval ${signed(path.lowPct)} to ${signed(path.highPct)}` : "History is shown; a future illustration needs enough overlapping observations.";
  document.querySelectorAll("[data-range]").forEach(button => { const active = Number(button.dataset.range) === state.range; button.classList.toggle("active", active); button.setAttribute("aria-pressed", active); });
  bindCharts($("#basket-chart"));
}
function basketChartShell() {
  return `<div class="basket-chart-heading"><h2>Your basket</h2><div class="range-tabs" aria-label="Historical chart range">${[[21,"1M"],[63,"3M"],[252,"1Y"]].map(([n,label]) => `<button data-range="${n}">${label}</button>`).join("")}</div></div><div id="basket-chart"></div><div class="chart-legend"><span><i></i>Observed history</span><span><i class="dashed"></i>Illustrative scenario</span><span><i class="band"></i>Fit uncertainty</span></div><p id="basket-chart-note" class="chart-caption"></p><p id="fit-interval" class="small-note"></p>`;
}
async function loadOutlook(request) {
  try {
    const data = state.analysis ?? await api("/api/analysis", { symbols: state.saved.symbols });
    if (request !== state.request || location.pathname !== "/basket") return;
    state.analysis = data;
    const selected = data.events.find(e => e.id === state.eventId) ?? data.events.find(e => e.status === "available") ?? data.events[0];
    if (selected?.id !== state.eventId) state.eventOpen = true;
    if (selected?.id !== state.eventId || !Number.isFinite(state.target)) state.target = Number.isFinite(selected?.probability) ? selected.probability : null;
    state.eventId = selected?.id ?? null;
    $("#analysis-content").innerHTML = `<div class="feed-meta"><span>${data.events.length} possibilities connected to your holdings</span><span>Prediction-market signals</span></div>
      <div class="event-feed" aria-label="Events that could affect your ETF">${data.events.map((event, i) => `<article class="event-post glass" aria-labelledby="event-title-${i}">
        <div class="event-post-heading"><span class="event-avatar ${escape(event.provider)}" aria-hidden="true">${event.provider === "kalshi" ? "K" : "P"}</span><div><span class="event-source">${sourceName(event.provider)}${event.url ? `<a href="${safeUrl(event.url)}" target="_blank" rel="noreferrer" aria-label="View ${escape(eventName(event))} on ${sourceName(event.provider)}">↗</a>` : ""}</span><span class="event-timestamp">${event.observedAt ? `Observed ${dateTime(event.observedAt)}` : "Quote unavailable"}</span></div><span class="event-odds">${event.status === "available" ? pct(event.probability) : "—"}<small>Yes odds</small></span></div>
        <button class="event-story" data-event="${escape(event.id)}" aria-expanded="false" aria-controls="scenario-panel"><span class="event-headline" id="event-title-${i}">${escape(eventName(event))}</span><span class="event-connection">${escape(event.businessLink)}</span><span class="event-holdings"><span>In your basket</span>${event.linkedHoldings.map(symbol => `<span class="holding-chip">${escape(symbol)}</span>`).join("")}</span><span class="event-story-footer"><span class="event-evidence">${fitLabel(event.fit)}</span><span class="event-action">Explore basket impact →</span></span></button>
      </article>`).join("")}</div>
      <section id="scenario-panel" class="scenario-panel thread-reply" aria-label="Selected event basket scenario" hidden><div id="scenario-controls"></div>${basketChartShell()}<div id="event-detail"></div></section>
      ${data.events.length ? "" : '<p class="empty-events glass">No verified events cover this basket in the current snapshot.</p>'}<div class="snapshot-bar"><span>Snapshot ${dateTime(data.builtAt)}</span><button id="refresh" class="text-button">Refresh observations ↻</button></div>`;
    if (selected) renderEventDetail();
    else {
      const panel = $("#scenario-panel"); panel.hidden = false; panel.classList.add("glass");
      $("#scenario-controls").hidden = true;
      $("#scenario-panel .chart-legend").innerHTML = '<span><i></i>Observed history</span>';
      updateScenario();
    }
  } catch (err) {
    if (request === state.request && location.pathname === "/basket") {
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
  if (location.pathname === "/events") history.replaceState({}, "", state.saved?.symbols.length ? "/basket#outlook" : "/");
  // A saved empty basket remains editable and its unallocated paper funds stay accessible.
  if (location.pathname === "/basket" && !state.saved) history.replaceState({}, "", "/");
  if (location.pathname === "/basket") { renderBasket(); if (location.hash === "#outlook") scrollToOutlook(); } else renderIdea();
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
  state.busy = true; error(); $("#suggest").disabled = true; $("#idea").disabled = true; $("#loading").hidden = false; $("#input-hint").hidden = true;
  try {
    const result = await api("/api/stocks", { idea });
    state.saved = createBasket(idea, result, state.overview.stocks.map(s => s.symbol));
    state.analysis = null; state.eventId = null; navigate("/basket"); save();
  } catch (err) { error(err.message); }
  finally { state.busy = false; if ($("#suggest")) { $("#suggest").disabled = false; $("#idea").disabled = false; $("#loading").hidden = true; $("#input-hint").hidden = false; } }
});
document.addEventListener("click", async event => {
  const route = event.target.closest("[data-route]");
  if (route && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.button === 0) { event.preventDefault(); navigate(route.dataset.route); return; }
  const button = event.target.closest("button"); if (!button || button.disabled) return;
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
    try { await api("/api/refresh", {}); if (request === state.request && location.pathname === "/basket") { state.analysis = null; await reloadOutlook(); } }
    catch (err) { if (button.isConnected) { $("#analysis-error").hidden = false; $("#analysis-error").textContent = err.message; button.disabled = false; button.textContent = "Refresh observations ↻"; } }
  }
  if (button.id === "export") {
    const url = URL.createObjectURL(new Blob([JSON.stringify(exportBasket(state.saved, state.overview.stocks), null, 2)], { type: "application/json" }));
    const link = document.createElement("a"); link.href = url; link.download = "my-basket.json"; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
});
document.addEventListener("input", event => {
  if (event.target.id === "probability") { state.target = Number(event.target.value)/100; updateScenario(); }
  if (event.target.id === "idea") resizeIdea();
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
try {
  state.overview = await api("/api/overview");
  try { state.saved = restoreBasket(sessionStorage.getItem(SESSION_KEY), state.overview.stocks.map(s => s.symbol)); } catch { /* memory-only flow */ }
  await renderPage();
} catch (err) { renderIdea(); error(err.message); }
