import { createController } from "./controller.js";
import { createMockServices } from "./services.js";
import { bindUI, render } from "./ui.js";

// The API and Polymarket teammates replace these adapters, not the flow logic.
const controller = createController(createMockServices());
history.replaceState(null, "", "#chat");
bindUI(controller);
let handlingNavigation = false;
controller.subscribe(state => {
  render(state);
  const hash = `#${state.view}`;
  if (location.hash !== hash) {
    if (handlingNavigation) history.replaceState(null, "", hash);
    else history.pushState(null, "", hash);
  }
});
window.addEventListener("hashchange", () => {
  handlingNavigation = true;
  controller.setView(location.hash.slice(1));
  handlingNavigation = false;
});
