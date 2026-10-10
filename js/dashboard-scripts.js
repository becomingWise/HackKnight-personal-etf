// Runs the real flow for the idea from the homepage (dashboard.html?idea=...) and shows the
// Polymarket evidence cards under the basket. Example for #23/#24: the basket panels above still
// show the old simulator; they should subscribe to this same controller later.
import { createController } from "./controller.js";
import { findStocks } from "./stock-api.js";
import { adjustWeights } from "./weights-api.js";
import { eventRisk } from "./risk-adapter.js";
import { renderEvidenceCards } from "./evidence-cards.js";

const evidenceContainer = document.getElementById("evidence");
const controller = createController({ findStocks, adjustWeights });
let riskFor = null;

controller.subscribe((state) => {
  if (state.status !== "ready") {
    evidenceContainer.textContent = state.error ?? (state.status === "idle" ? "" : "Checking Polymarket odds…");
    return;
  }
  renderEvidenceCards(evidenceContainer, state.adjustment); // odds cards right away
  const key = JSON.stringify(state.holdings);
//  console.log(state.holdings);	// doesn't work
  if (riskFor === key) return;
  riskFor = key;
  eventRisk({ holdings: state.holdings }) // then add "If yes / If no"
    .then((risk) => { if (riskFor === key) renderEvidenceCards(evidenceContainer, state.adjustment, risk); })
    .catch(() => {}); // the cards still work without risk data
	
});

const idea = new URLSearchParams(location.search).get("idea");
function getExactType(value) {
    return Object.prototype.toString.call(value).slice(8, -1).toLowerCase();
}
if (idea) controller.submitIdea(idea);