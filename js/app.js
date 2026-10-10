import { validateBasket, calculateBasket, applyScenario, equalWeightHoldings } from "./portfolio.js";
import { renderBuilder, updateBuilder, renderErrors, renderResult, renderScenarioControls, renderScenario, showReady, showLoadError } from "./ui.js";


const demoState = () => ({
  budget: 1000,
  holdings: [
    { assetId: "SOLAR_DEMO", weightPct: 50 },
    { assetId: "TECH_DEMO", weightPct: 30 },
    { assetId: "HEALTH_DEMO", weightPct: 20 }
  ],
  interest: "all",
  scenarioChanges: {}
});

let state = demoState();
let assets = [];
let result = null;

function update() {
  updateBuilder(assets, state);
  const errors = validateBasket(state, assets);
  renderErrors(errors);
  result = errors.length ? null : calculateBasket(state, assets);
  renderResult(result);
  if (result) {
    renderScenarioControls(result, state.scenarioChanges);
    renderScenario(applyScenario(result, state.scenarioChanges));
  }
}

function dispatch(action) {
  switch (action.type) {
    case "budget": state.budget = action.value; break;
    case "weight": state.holdings.find(holding => holding.assetId === action.id).weightPct = action.value; break;
    case "filter": state.interest = action.interest; break;
    case "select": {
      const ids = state.holdings.map(holding => holding.assetId);
      const nextIds = action.selected ? [...ids, action.id] : ids.filter(id => id !== action.id);
      state.holdings = equalWeightHoldings(nextIds);
      state.scenarioChanges = Object.fromEntries(Object.entries(state.scenarioChanges).filter(([id]) => nextIds.includes(id)));
      break;
    }
    case "equalize": state.holdings = equalWeightHoldings(state.holdings.map(holding => holding.assetId)); break;
    case "reset": state = demoState(); break;
    case "scenario": state.scenarioChanges[action.id] = action.value; break;
    case "export": {
      if (!result) return;
      const payload = {
        name: "MyETF experiment",
        mode: "educational-mock",
        priceSource: "Fictional companies and made-up prices",
        createdAt: new Date().toISOString(),
        basket: result,
        scenario: applyScenario(result, state.scenarioChanges)
      };
      const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = "myetf-basket.json";
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return;
    }
  }
  update();
}

async function start() {
  try {
    const response = await fetch(new URL("../data/assets.json", import.meta.url));
    if (!response.ok) throw new Error(`Could not load mock data: ${response.status}`);
    assets = await response.json();
    renderBuilder(assets, dispatch);

    update();
    showReady();
  } catch (error) {
    console.error(error);
    showLoadError();
  }
}

start();
