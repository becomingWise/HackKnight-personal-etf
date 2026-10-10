// Evidence and event-risk cards shown under the basket (issue #24, spec: TEAM_HANDOFF.md → "On screen").
//
// Usage in js/app.js, once state.status === "ready":
//
//   import { renderEvidenceCards } from "./evidence-cards.js";
//   import { eventRisk } from "./risk-adapter.js";
//
//   const el = document.querySelector("#evidence");      // any empty container
//   renderEvidenceCards(el, state.adjustment);             // odds cards right away
//   eventRisk({ holdings: state.holdings })                // then add "If yes / If no"
//     .then((risk) => renderEvidenceCards(el, state.adjustment, risk))
//     .catch(() => {});                                    // cards still work without risk data
//
// Refresh by calling eventRisk + renderEvidenceCards again about every 60 s (odds are cached 60 s).
// Styles: link css/evidence-cards.css (all classes start with "ec-"); restyle freely.
// Market text is always set as text, never as HTML.

export const CAVEAT = "Event probabilities indicate risk, not expected returns.";
export const EMPTY_MESSAGE = "No live Polymarket market is linked to these stocks.";

const defaultFormatTime = (iso) =>
  new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

const percent = (probability) => `${(probability * 100).toFixed(1)}%`;

function signed(value) {
  const text = Math.abs(value).toFixed(1);
  if (Number(text) === 0) return "0.0%";
  return `${value > 0 ? "+" : "−"}${text}%`;
}

function weeklyMove(change7d) {
  if (typeof change7d !== "number") return "No weekly change data";
  const points = Math.abs(change7d * 100).toFixed(1);
  if (Number(points) === 0) return "Flat this week";
  return `${change7d > 0 ? "▲" : "▼"} ${points} pts this week`;
}

const marketKey = (market) => `${market.url}\n${market.title}`;

/**
 * Turns the controller's `state.adjustment` and an optional /api/risk response into display strings.
 * Pure: no DOM, no network.
 */
export function buildEvidenceCards(adjustment, risk = null, { formatTime = defaultFormatTime } = {}) {
  const evidence = Array.isArray(adjustment?.evidence) ? adjustment.evidence : [];
  const riskByMarket = new Map((risk?.markets ?? []).map((market) => [marketKey(market), market]));

  const cards = evidence.map((item) => {
    const match = riskByMarket.get(marketKey(item));
    return {
      title: item.title,
      url: item.url,
      odds: `${item.outcome} ${percent(item.probability)}`,
      move: weeklyMove(item.change7d),
      tickers: (item.symbols ?? []).join(", "),
      asOf: `as of ${formatTime(item.observedAt)}`,
      risk: match ? `If yes: ${signed(match.ifYesPct)} · If no: ${signed(match.ifNoPct)}` : null
    };
  });

  const uncovered = risk?.uncovered?.length ? `No measurable event exposure: ${risk.uncovered.join(", ")}` : null;
  const notes = [CAVEAT, ...(risk ? [risk.note, risk.basis].filter(Boolean) : [])];

  return {
    explanation: adjustment?.explanation ?? "",
    cards,
    uncovered,
    notes,
    empty: cards.length ? null : EMPTY_MESSAGE
  };
}

const isWebUrl = (value) => {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
};

/**
 * Renders the cards into `container`, replacing what was there. Safe to call on every refresh.
 * `options.document` and `options.formatTime` exist for tests.
 */
export function renderEvidenceCards(container, adjustment, risk = null, options = {}) {
  const doc = options.document ?? globalThis.document;
  const view = buildEvidenceCards(adjustment, risk, options);
  const el = (tag, className, text) => {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  };

  const parts = [];
  if (view.explanation) parts.push(el("p", "ec-explanation", view.explanation));
  if (view.empty) parts.push(el("p", "ec-empty", view.empty));

  if (view.cards.length) {
    const list = el("ul", "ec-list");
    for (const card of view.cards) {
      const item = el("li", "ec-card");
      let title;
      if (isWebUrl(card.url)) {
        title = el("a", "ec-title", card.title);
        title.setAttribute("href", card.url);
        title.setAttribute("target", "_blank");
        title.setAttribute("rel", "noopener noreferrer");
      } else {
        title = el("span", "ec-title", card.title);
      }
      item.append(
        title,
        el("span", "ec-odds", card.odds),
        el("span", "ec-move", card.move),
        el("span", "ec-tickers", card.tickers),
        el("span", "ec-asof", card.asOf)
      );
      if (card.risk) item.append(el("span", "ec-risk", card.risk));
      list.append(item);
    }
    parts.push(list);
  }

  if (view.uncovered) parts.push(el("p", "ec-uncovered", view.uncovered));
  const notes = el("div", "ec-notes");
  notes.append(...view.notes.map((note) => el("p", "ec-note", note)));
  parts.push(notes);

  container.replaceChildren(...parts);
}
