const $ = id => document.getElementById(id);
const percent = value => `${Number(value.toFixed(2))}%`;
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/** Reference view. Replace styling/rendering without changing the controller. */
export function bindUI(controller) {
  document.querySelector(".skip-link").addEventListener("click", event => {
    event.preventDefault();
    $("main").focus();
  });
  $("idea-form").addEventListener("submit", event => {
    event.preventDefault();
    controller.submitIdea($("idea-input").value);
  });
  $("edit-idea").addEventListener("click", () => { controller.editIdea(); $("idea-input").focus(); });
  $("start-over").addEventListener("click", () => { controller.reset(); $("idea-input").focus(); });
}

let previousView = "chat";
export function render(state) {
  const dashboard = state.view === "dashboard";
  const busy = ["finding", "adjusting"].includes(state.status);
  $("chat-view").hidden = dashboard;
  $("dashboard-view").hidden = !dashboard;
  $("start-over").hidden = !state.idea && !busy;
  $("build-basket").disabled = busy;
  $("idea-input").disabled = busy;
  $("idea-form").setAttribute("aria-busy", String(busy));
  $("idea-input").setAttribute("aria-invalid", String(Boolean(state.error)));
  if (document.activeElement !== $("idea-input")) $("idea-input").value = state.idea;
  $("chat-error").textContent = state.error ?? "";
  $("chat-error").hidden = !state.error;
  const messages = state.messages.map(message => {
    const paragraph = element("p", `message ${message.role}`);
    paragraph.append(element("span", "visually-hidden", message.role === "assistant" ? "MyETF: " : "You: "), document.createTextNode(message.content));
    return paragraph;
  });
  $("messages").replaceChildren(...messages);
  if (dashboard) {
    $("submitted-idea").textContent = state.idea;
    $("basket-summary").textContent = state.summary;
    $("current-heading").textContent = state.adjustment.status === "adjusted" ? "Adjusted" : "Current";
    $("stock-rows").replaceChildren(...state.stocks.map(stock => {
      const row = element("div", "stock-row"); row.setAttribute("role", "row");
      const company = element("div", "company"); company.setAttribute("role", "cell");
      company.append(element("span", "company-name", stock.name), element("span", "company-symbol", stock.symbol), element("p", "company-reason", stock.reason));
      const starting = element("span", "weight starting", percent(state.startingHoldings.find(item => item.symbol === stock.symbol).weightPct));
      const current = element("span", "weight current", percent(state.holdings.find(item => item.symbol === stock.symbol).weightPct));
      starting.setAttribute("role", "cell"); current.setAttribute("role", "cell");
      row.append(company, starting, current);
      return row;
    }));
    const labels = { pending: "Checking…", adjusted: "Adjusted", unchanged: "Unchanged", unavailable: "Starting weights retained" };
    $("adjustment-status").textContent = labels[state.adjustment.status];
    $("adjustment-explanation").textContent = state.adjustment.explanation;
    $("market-evidence").hidden = !state.adjustment.evidence.length;
    $("market-evidence").replaceChildren(...state.adjustment.evidence.map(item => {
      const li = element("li");
      const link = element("a", "", item.title);
      link.href = item.url; link.target = "_blank"; link.rel = "noopener noreferrer";
      li.append(link, document.createTextNode(` — ${item.outcome}: ${percent(item.probability * 100)} (observed ${item.observedAt})`));
      return li;
    }));
  }
  if (state.view !== previousView) {
    (dashboard ? $("dashboard-title") : $("idea-input")).focus();
    previousView = state.view;
  }
}
