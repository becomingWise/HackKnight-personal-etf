const $ = id => document.getElementById(id);
const money = value => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value);
const percent = value => `${Number(value.toFixed(2))}%`;
const labels = { technology: "Technology", "clean-energy": "Clean energy", healthcare: "Healthcare" };
const escape = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
let holdingsSignature = "";
let scenarioSignature = "";

export function renderBuilder(assets, onAction) {
  $("company-grid").innerHTML = assets.map(asset => `
    <label class="company-card ${escape(asset.interest)}" data-company="${escape(asset.id)}">
      <input type="checkbox" data-asset-id="${escape(asset.id)}" aria-label="Select ${escape(asset.name)}">
      <span class="company-symbol" aria-hidden="true">${escape(asset.symbol)}</span>
      <span class="company-name">${escape(asset.name)}</span>
      <span class="company-meta"><span>${escape(labels[asset.interest] ?? asset.interest)}</span><span class="company-price">${money(asset.price)}</span></span>
    </label>`).join("");
  $("company-grid").addEventListener("change", event => {
    const input = event.target.closest("input[data-asset-id]");
    if (input) onAction({ type: "select", id: input.dataset.assetId, selected: input.checked });
  });
  $("interest-filters").addEventListener("click", event => {
    const button = event.target.closest("button[data-interest]");
    if (button) onAction({ type: "filter", interest: button.dataset.interest });
  });
  $("budget").addEventListener("input", event => onAction({ type: "budget", value: event.target.valueAsNumber }));
  $("holding-inputs").addEventListener("input", event => {
    const input = event.target.closest("input[data-weight-id]");
    if (input) onAction({ type: "weight", id: input.dataset.weightId, value: input.valueAsNumber });
  });
  $("equal-weights").addEventListener("click", () => onAction({ type: "equalize" }));
  $("reset-demo").addEventListener("click", () => onAction({ type: "reset" }));
  $("export-basket").addEventListener("click", () => onAction({ type: "export" }));
  $("scenario-controls").addEventListener("input", event => {
    const input = event.target.closest("input[data-scenario-id]");
    if (input) onAction({ type: "scenario", id: input.dataset.scenarioId, value: input.valueAsNumber });
  });
}

export function updateBuilder(assets, state) {
  const selected = new Set(state.holdings.map(holding => holding.assetId));
  $("selection-count").textContent = `${selected.size} selected`;
  $("equal-weights").disabled = selected.size === 0;
  for (const asset of assets) {
    const card = document.querySelector(`[data-company="${asset.id}"]`);
    card.hidden = state.interest !== "all" && state.interest !== asset.interest;
    card.classList.toggle("is-selected", selected.has(asset.id));
    card.querySelector("input").checked = selected.has(asset.id);
  }
  for (const button of $("interest-filters").querySelectorAll("button")) {
    const active = button.dataset.interest === state.interest;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  }
  if (document.activeElement !== $("budget")) $("budget").value = Number.isFinite(state.budget) ? state.budget : "";
  const signature = state.holdings.map(holding => holding.assetId).join(",");
  if (signature !== holdingsSignature || !$("holding-inputs").childElementCount) {
    holdingsSignature = signature;
    $("holding-inputs").innerHTML = state.holdings.map(holding => {
      const asset = assets.find(asset => asset.id === holding.assetId);
      return `<div class="holding-input-row ${escape(asset.interest)}">
        <div class="holding-info"><span class="holding-symbol" aria-hidden="true">${escape(asset.symbol)}</span><div><div class="holding-name">${escape(asset.name)}</div><div class="holding-detail">${escape(labels[asset.interest])} · ${money(asset.price)} mock price</div></div></div>
        <label class="weight-input"><input aria-label="${escape(asset.name)} weight" type="number" data-weight-id="${escape(asset.id)}" min="0.01" max="100" step="0.01" inputmode="decimal"><span aria-hidden="true">%</span></label>
      </div>`;
    }).join("");
  }
  for (const holding of state.holdings) {
    const input = document.querySelector(`[data-weight-id="${holding.assetId}"]`);
    if (input !== document.activeElement) input.value = Number.isFinite(holding.weightPct) ? holding.weightPct : "";
  }
  const total = state.holdings.reduce((sum, holding) => sum + (Number.isFinite(holding.weightPct) ? holding.weightPct : 0), 0);
  $("weight-total").textContent = percent(total);
  $("weight-total").classList.toggle("invalid", Math.abs(total - 100) > 0.010000001);
}

export function renderErrors(errors) {
  $("validation-errors").hidden = errors.length === 0;
  $("validation-errors").innerHTML = errors.length ? `<ul>${errors.map(error => `<li>${escape(error)}</li>`).join("")}</ul>` : "";
  $("budget").setAttribute("aria-invalid", String(errors.some(error => error.includes("budget"))));
  for (const input of $("holding-inputs").querySelectorAll("input")) {
    input.setAttribute("aria-invalid", String(errors.some(error => error.includes("weight"))));
  }
}

export function renderResult(result) {
  $("results-content").hidden = !result;
  $("results-empty").hidden = Boolean(result);
  $("scenario-content").hidden = !result;
  $("scenario-empty").hidden = Boolean(result);
  if (!result) return;
  $("basket-value").textContent = money(result.budget);
  const interests = Object.entries(result.interestWeights);
  $("basket-description").textContent = `${result.holdings.length} companies · ${interests.length} ${interests.length === 1 ? "interest" : "interests"}`;
  $("allocation-chart").innerHTML = interests.map(([interest, weight]) => `<span class="chart-segment ${escape(interest)}" style="width:${weight}%"></span>`).join("");
  $("allocation-chart").setAttribute("aria-label", interests.map(([interest, weight]) => `${labels[interest]} ${percent(weight)}`).join(", "));
  $("chart-legend").innerHTML = interests.map(([interest, weight]) => `<span class="legend-item ${escape(interest)}"><span class="legend-dot" aria-hidden="true"></span>${escape(labels[interest])} ${percent(weight)}</span>`).join("");
  $("result-holdings").innerHTML = result.holdings.map(holding => `<div class="result-row ${escape(holding.interest)}">
    <div class="holding-info"><span class="holding-symbol" aria-hidden="true">${escape(holding.symbol)}</span><div><div class="holding-name">${escape(holding.name)}</div><div class="holding-detail">${percent(holding.weightPct)} of your basket</div></div></div>
    <div class="result-amount">${money(holding.dollars)}<small>${holding.units.toLocaleString("en-US", { maximumFractionDigits: 4 })} simulated units</small></div>
  </div>`).join("");
  $("largest-holding").textContent = percent(result.largestWeightPct);
  $("interest-count").textContent = interests.length;
}

export function renderScenarioControls(result, changes) {
  if (!result) return;
  const signature = result.holdings.map(holding => holding.id).join(",");
  if (signature !== scenarioSignature) {
    scenarioSignature = signature;
    $("scenario-controls").innerHTML = result.holdings.map(holding => `<div class="scenario-control">
      <div class="scenario-control-header"><label for="scenario-${escape(holding.id)}">${escape(holding.name)}</label><output id="change-${escape(holding.id)}" for="scenario-${escape(holding.id)}">0%</output></div>
      <input id="scenario-${escape(holding.id)}" data-scenario-id="${escape(holding.id)}" type="range" min="-100" max="100" step="1" value="0" aria-label="${escape(holding.name)} price change">
      <div class="range-labels" aria-hidden="true"><span>−100%</span><span>0%</span><span>+100%</span></div>
    </div>`).join("");
  }
  for (const holding of result.holdings) {
    const value = changes[holding.id] ?? 0;
    const input = $(`scenario-${holding.id}`);
    input.value = value;
    input.setAttribute("aria-valuetext", `${value > 0 ? "+" : ""}${value}% price change`);
    $(`change-${holding.id}`).textContent = `${value > 0 ? "+" : ""}${value}%`;
  }
}

export function renderScenario(scenario) {
  $("scenario-value").textContent = money(scenario.scenarioValue);
  const change = Math.abs(scenario.changePct) < 0.000001 ? 0 : scenario.changePct;
  $("scenario-change").textContent = `${change > 0 ? "+" : ""}${change.toFixed(2)}%`;
  $("scenario-change").className = `scenario-change ${change > 0 ? "positive" : change < 0 ? "negative" : "neutral"}`;
}

export function showReady() {
  $("loading-message").hidden = true;
  $("app-content").hidden = false;
}

export function showLoadError() {
  $("loading-message").textContent = "The sample companies could not load. Run the local server from the project folder and refresh. Check the README for the startup command.";
}
