import { allocate, validateCaps, scenario } from "./math.js";

const $ = selector => document.querySelector(selector);
const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const pct = value => `${(value * 100).toFixed(1)}%`;
const signed = value => `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
const safeUrl = value => { try { const url = new URL(value); return ["http:", "https:"].includes(url.protocol) ? escape(url.href) : "#"; } catch { return "#"; } };
const state = { overview: null, candidates: [], selected: new Set(), method: "equal", caps: {}, active: null, events: [], eventId: null, request: 0, busy: false, source: "preview" };
const sessionId = crypto.randomUUID();

async function api(path, body) {
  const response = await fetch(path, body ? { method: "POST", headers: { "Content-Type": "application/json", "X-Session-Id": sessionId }, body: JSON.stringify(body) } : {});
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message ?? "The request failed.");
  return result;
}
function error(message = "") { $("#error").hidden = !message; $("#error").textContent = message; }
const allStocks = () => new Map((state.overview?.stocks ?? []).map(stock => [stock.symbol, stock]));

function renderCandidates() {
  const stocks = allStocks();
  $("#candidate-count").textContent = state.candidates.length;
  $("#candidates").innerHTML = state.candidates.map(({ symbol, name }) => {
    const meta = stocks.get(symbol), selected = state.selected.has(symbol);
    return `<article class="stock-card ${state.active === symbol ? "active" : ""}"><div class="stock-top"><div class="ticker-mark">${escape(symbol.slice(0, 3))}</div><div class="stock-info"><strong>${escape(symbol)}</strong><small title="${escape(name)}">${escape(name)}</small></div>${meta?.lastClose ? `<span class="price">$${meta.lastClose.close.toFixed(2)}</span>` : ""}</div><div class="stock-meta"><span>${escape(meta?.sector ?? "Company")}</span><span>${meta?.eventCount ?? 0} open events</span></div><div class="stock-actions"><button class="inspect-button" data-inspect="${escape(symbol)}" aria-label="Inspect events for ${escape(symbol)}">Explore events ↗</button><button class="add-button ${selected ? "selected" : ""}" data-add="${escape(symbol)}" aria-pressed="${selected}">${selected ? "✓ Added" : "+ Add"}</button></div></article>`;
  }).join("");
}

function renderBasket() {
  const stocks = allStocks();
  const selected = [...state.selected].map(symbol => stocks.get(symbol)).filter(Boolean);
  const canCap = selected.length > 0 && selected.every(stock => state.caps[stock.symbol]);
  if (!canCap) state.method = "equal";
  $("#weight-method option[value='float-cap']").disabled = !canCap;
  $("#weight-method").value = state.method;
  const holdings = allocate(selected, state.method, state.caps);
  $("#basket-count").textContent = holdings.length;
  $("#clear").disabled = !holdings.length;
  $("#export").disabled = !holdings.length;
  $("#basket").innerHTML = holdings.length ? holdings.map(stock => `<div class="basket-row"><div><strong>${escape(stock.symbol)}</strong><small>${escape(stock.name)}</small><div class="allocation-bar"><span style="width:${stock.weightPct}%"></span></div>${state.method === "float-cap" ? `<small><a href="${safeUrl(state.caps[stock.symbol].source)}" target="_blank" rel="noreferrer">Cap as of ${escape(state.caps[stock.symbol].asOf)}</a></small>` : ""}</div><span class="weight">${stock.weightPct.toFixed(2)}%</span><button class="remove-button" data-remove="${escape(stock.symbol)}" aria-label="Remove ${escape(stock.symbol)}">×</button></div>`).join("") + `<div class="basket-total"><span>TOTAL ALLOCATION</span><strong>100.00%</strong></div>`
    : `<div class="empty-basket"><span class="empty-icon">＋</span>Your basket starts empty.<br>Add companies from the shortlist.</div>`;
  $("#weight-note").textContent = state.method === "equal" ? "Each selected company receives the same share. Market-cap weighting unlocks when every selection has sourced float-adjusted data." : "Weighted by float-adjusted market value across your selections. Polymarket scenarios leave these weights unchanged.";
}

async function inspect(symbol) {
  state.active = symbol; state.events = []; state.eventId = null;
  const request = ++state.request;
  renderCandidates(); $("#active-symbol").textContent = symbol;
  $("#event-list").innerHTML = '<p class="loading">Reading historical observations…</p>';
  $("#scenario").innerHTML = '<p class="loading">Looking for overlapping stock and event history…</p>';
  try {
    const result = await api(`/api/events?symbol=${encodeURIComponent(symbol)}`);
    if (request !== state.request) return;
    state.events = result.events; state.eventId = result.events[0]?.id;
    renderEvents();
  } catch (err) { if (request === state.request) { $("#scenario").textContent = err.message; $("#event-list").textContent = "Could not load events."; } }
}
const status = fit => fit.status === "observed" ? "Observed association" : fit.status === "insufficient" ? "Not enough history" : "Weak evidence";

function renderEvents() {
  $("#event-list").innerHTML = state.events.length ? state.events.map(event => `<button class="event-button ${event.id === state.eventId ? "active" : ""}" data-event="${escape(event.id)}" aria-pressed="${event.id === state.eventId}"><strong>${escape(event.title ?? event.label)}</strong><span class="event-foot"><span class="odds">${Number.isFinite(event.probability) ? pct(event.probability) + " Yes" : "Market unavailable"}</span><span class="tag ${event.fit.status === "insufficient" ? "missing" : event.fit.status === "observed" ? "" : "weak"}">${status(event.fit)}</span></span></button>`).join("")
    : '<p class="missing-message">No configured business-event link covers this company yet. This does not mean the company has no event risk.</p>';
  renderScenario();
}

function scatter(fit, delta = 0) {
  const width = 610, height = 175, pad = 28;
  const points = fit.points;
  const limit = Math.max(fit.maxDailyMove, ...points.map(p => Math.abs(p.x)), Math.abs(delta), 0.01) * 1.1;
  const yLimit = Math.max(...points.map(p => Math.abs(p.y)), Math.abs(fit.slope * limit), 0.01) * 1.1;
  const x = n => pad + (n + limit) / (2 * limit) * (width - 2 * pad);
  const y = n => height - pad - (n + yLimit) / (2 * yLimit) * (height - 2 * pad);
  return `<svg class="scatter" viewBox="0 0 ${width} ${height}" role="img" aria-label="Historical odds changes versus stock returns adjusted for SPY, with the fitted association line"><line x1="${pad}" y1="${y(0)}" x2="${width-pad}" y2="${y(0)}" stroke="#d6ded2"/><line x1="${x(0)}" y1="${pad}" x2="${x(0)}" y2="${height-pad}" stroke="#d6ded2"/>${points.map(p => `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="2.4" fill="#7c9c8c" opacity=".5"/>`).join("")}<line x1="${x(-limit)}" y1="${y(-limit*fit.slope)}" x2="${x(limit)}" y2="${y(limit*fit.slope)}" stroke="#17634d" stroke-width="1.6"/><circle cx="${x(delta)}" cy="${y(delta*fit.slope)}" r="5" fill="#d6a54f" stroke="#fffef9" stroke-width="2"/><text x="${pad}" y="${height-5}" font-size="9" fill="#707c75">−${(limit*100).toFixed(1)} pts</text><text x="${width-pad}" y="${height-5}" text-anchor="end" font-size="9" fill="#707c75">+${(limit*100).toFixed(1)} pts</text></svg>`;
}

function renderScenario() {
  const event = state.events.find(e => e.id === state.eventId);
  if (!event) { $("#scenario").innerHTML = '<p class="missing-message">Choose another company to explore its related events.</p>'; return; }
  const { fit } = event;
  const header = `<div class="scenario-top"><h3>${escape(event.title ?? event.label)}</h3>${event.url ? `<a class="external-link" href="${safeUrl(event.url)}" target="_blank" rel="noreferrer">Polymarket ↗</a>` : ""}</div><p class="business-link"><strong>Business connection:</strong> ${escape(event.businessLink)}</p>`;
  if (fit.status === "insufficient") {
    $("#scenario").innerHTML = header + `<div class="metrics"><div class="metric"><span>OVERLAPPING DAYS</span><strong>${fit.n}</strong></div><div class="metric"><span>HISTORICAL STRENGTH</span><strong>Unavailable</strong></div><div class="metric"><span>SCENARIO</span><strong>Needs history</strong></div></div><p class="missing-message">${escape(event.reason ?? fit.reason)} We need at least 60 overlapping trading-day changes with enough odds movement. A business link alone doesn't justify a price estimate.</p>`;
    return;
  }
  $("#scenario").innerHTML = header + `<div class="metrics"><div class="metric"><span>HISTORICAL STRENGTH</span><strong>${(fit.partialR2*100).toFixed(1)}%</strong><small>Partial R² · variation associated</small></div><div class="metric"><span>OVERLAPPING DAYS</span><strong>${fit.n}</strong><small>${escape(fit.start)} → ${escape(fit.end)}</small></div><div class="metric"><span>ESTIMATE PER +10 PTS</span><strong class="${fit.slope>=0?"positive":"negative"}">${signed(fit.slope*10)}</strong><small>Same-day return relative to SPY</small></div></div><div class="slider-head"><label for="probability">What if the event's odds change?</label><div class="scenario-values">${pct(event.probability)}<span>→</span><output id="target-probability">${pct(event.probability)}</output></div></div><input id="probability" type="range" min="0" max="100" step="0.1" value="${event.probability*100}" aria-label="Hypothetical Yes probability"><div class="range-labels"><span>0% Yes</span><button id="reset-scenario" class="text-button">Reset to observed odds</button><span>100% Yes</span></div><div id="scenario-output"></div><div id="scatter" class="chart-wrap"></div><p class="chart-caption">Each dot is an observed trading day. Both axes are adjusted for SPY; the line is the fitted historical association.</p><details class="historical-details"><summary>Data & reliability</summary><p>Same-day OLS: stock return ~ odds change + SPY return. Lag-5 Newey–West errors. R² is for the odds term after controlling for SPY. The displayed 95% interval describes uncertainty in the fitted mean, not the range of future stock returns.</p><p>Later sample: ${fit.holdout ? `${fit.holdout.n} days (${escape(fit.holdout.start)} → ${escape(fit.holdout.end)}); direction ${fit.holdout.directionStable?"consistent":"changed"}.` : "not enough data to check direction."} Multiple-event correction q=${fit.qValue.toFixed(3)} (approximate, exploratory). These checks do not establish causation.</p><p>12-hour odds snapshots before the US close; snapshots more than 18 hours old are excluded. Weekend changes roll into the next trading day. Incomplete current-day prices and returns beyond ±20% are excluded.</p><p>Largest observed daily odds change: ${(fit.maxDailyMove*100).toFixed(1)} points. Other events can overlap. Treat every scenario as a single-event illustration; do not add estimates across events.</p><p><a href="${safeUrl(event.historySource)}" target="_blank" rel="noreferrer">Observed odds source ↗</a> · <a href="https://finance.yahoo.com/quote/${encodeURIComponent(state.active)}/history/" target="_blank" rel="noreferrer">Stock-price source ↗</a></p></details>`;
  updateScenario(event.probability);
}

function updateScenario(target) {
  const event = state.events.find(e => e.id === state.eventId), { fit } = event;
  const result = scenario(fit, event.probability, target);
  $("#target-probability").textContent = pct(target);
  $("#scenario-output").innerHTML = `<div class="scenario-result"><div><p class="eyebrow">${escape(state.active)} / HISTORICAL ASSOCIATION</p><strong class="${result.estimatePct >= 0 ? "positive" : "negative"}">${signed(result.estimatePct)}</strong><small>Relative to SPY · basket allocation unchanged</small></div><div><p class="eyebrow">95% INTERVAL FOR THE FIT</p><span class="interval">${signed(result.lowPct)} to ${signed(result.highPct)}</span><small>Not a forecast or future-price interval</small></div></div>${fit.status !== "observed" ? '<p class="caution">Weak historical evidence: the interval may include zero or the relationship may not hold in the later sample. This estimate is exploratory.</p>' : '<p class="caution">An association was observed in this sample. It does not establish a future return or a causal effect.</p>'}${result.extrapolated ? '<p class="caution">Outside the largest observed daily odds move. This slider position extrapolates beyond the measured data.</p>' : ""}`;
  $("#scatter").innerHTML = scatter(fit, target - event.probability);
}

async function suggest() {
  if (state.busy) return;
  state.busy = true; error(); $("#suggest").disabled = true; $("#suggest").textContent = "Finding candidates…";
  document.querySelectorAll("#idea, #mode, .quick-ideas button").forEach(control => { control.disabled = true; });
  try {
    const result = await api("/api/stocks", { idea: $("#idea").value.trim(), mode: $("#mode").value });
    state.candidates = result.stocks; state.source = result.source;
    $("#summary").textContent = result.summary;
    $("#source-note").textContent = result.source === "gemini" ? "Gemini suggested these companies. Nothing is added until you choose it." : "Example shortlist ranked by matching sectors. Historical event data comes from observed public sources.";
    renderCandidates(); renderBasket();
    await inspect(state.candidates[0].symbol);
  } catch (err) { error(err.message); }
  finally { state.busy = false; $("#suggest").disabled = false; $("#suggest").innerHTML = 'Explore stocks <span>↗</span>'; document.querySelectorAll("#idea, #mode, .quick-ideas button").forEach(control => { control.disabled = false; }); }
}

$("#idea-form").addEventListener("submit", event => { event.preventDefault(); void suggest(); });
document.addEventListener("click", event => {
  const button = event.target.closest("button");
  if (!button) return;
  if (button.dataset.add) { const symbol = button.dataset.add; state.selected.has(symbol) ? state.selected.delete(symbol) : state.selected.add(symbol); renderCandidates(); renderBasket(); }
  if (button.dataset.remove) { state.selected.delete(button.dataset.remove); renderCandidates(); renderBasket(); }
  if (button.dataset.inspect) void inspect(button.dataset.inspect);
  if (button.dataset.event) { state.eventId = button.dataset.event; renderEvents(); }
  if (button.dataset.idea) { $("#idea").value = button.dataset.idea; void suggest(); }
  if (button.id === "reset-scenario") { const event = state.events.find(e => e.id === state.eventId); $("#probability").value = event.probability * 100; updateScenario(event.probability); }
});
document.addEventListener("input", event => { if (event.target.id === "probability") updateScenario(Number(event.target.value) / 100); });
$("#clear").addEventListener("click", () => { state.selected.clear(); renderCandidates(); renderBasket(); });
$("#weight-method").addEventListener("change", event => { state.method = event.target.value; renderBasket(); });
$("#caps-file").addEventListener("change", async event => {
  error();
  try { const file = event.target.files[0]; if (!file) return; if (file.size > 100000) throw new Error("Use a market-cap file smaller than 100 KB."); state.caps = validateCaps(JSON.parse(await file.text())); renderBasket(); }
  catch (err) { error(err.message); }
});
$("#export").addEventListener("click", () => {
  const stocks = allStocks();
  const data = { idea: $("#idea").value, suggestedBy: state.source, weightingMethod: state.method, holdings: allocate([...state.selected].map(s => stocks.get(s)), state.method, state.caps),
    capitalization: state.method === "float-cap" ? Object.fromEntries([...state.selected].map(s => [s, state.caps[s]])) : null,
    note: "Paper basket. Event scenarios do not change allocation.", exportedAt: new Date().toISOString() };
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
  const a = document.createElement("a"); a.href = url; a.download = "my-basket.json"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});
async function overview() {
  state.overview = await api("/api/overview");
  $("#mode option[value='gemini']").disabled = !state.overview.geminiConfigured;
  $("#snapshot-time").textContent = state.overview.builtAt ? `Snapshot ${new Date(state.overview.builtAt).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZone: "America/New_York" })} ET` : "No observations loaded";
}
$("#refresh").addEventListener("click", async () => {
  $("#refresh").disabled = true; $("#refresh").textContent = "Refreshing…"; error();
  try { await api("/api/refresh", {}); await overview(); renderCandidates(); renderBasket(); if (state.active) await inspect(state.active); }
  catch (err) { error(err.message); }
  finally { $("#refresh").disabled = false; $("#refresh").textContent = "Refresh observations ↻"; }
});
try { await overview(); renderBasket(); await suggest(); } catch (err) { error(err.message); }
