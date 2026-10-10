// Runs the real flow for the idea from the homepage (dashboard.html?idea=...) and shows the
// Polymarket evidence cards under the basket. Example for #23/#24: the basket panels above still
// show the old simulator; they should subscribe to this same controller later.
import { createController } from "./controller.js";
import { findStocks } from "./stock-api.js";
import { adjustWeights } from "./weights-api.js";
import { eventRisk } from "./risk-adapter.js";
import { renderEvidenceCards } from "./evidence-cards.js";

const el = document.getElementById("evidence");
const controller = createController({ findStocks, adjustWeights });
let riskFor = null;

controller.subscribe((state) => {
  if (state.status !== "ready") {
    el.textContent = state.error ?? (state.status === "idle" ? "" : "Checking Polymarket odds…");
    return;
  }
  renderEvidenceCards(el, state.adjustment); // odds cards right away
  const key = JSON.stringify(state.holdings);
  if (riskFor === key) return;
  riskFor = key;
  eventRisk({ holdings: state.holdings }) // then add "If yes / If no"
    .then((risk) => { if (riskFor === key) renderEvidenceCards(el, state.adjustment, risk); })
    .catch(() => {}); // the cards still work without risk data
});

const idea = new URLSearchParams(location.search).get("idea");
if (idea) controller.submitIdea(idea);
