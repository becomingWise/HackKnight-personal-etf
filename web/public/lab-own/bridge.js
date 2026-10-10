// The link between the AI page (/) and Shaun's Lab (/lab). This file is ours; the Lab's own files
// are the copies in ../lab-static (see scripts/sync-lab.mjs) and import this one first.
//
// 1. Hand-off: /lab/basket?symbols=NVDA,TSM,TLT&idea=... loads those symbols as the Lab's basket
//    with no Gemini call. Symbols the Lab cannot price (funds such as TLT or IBIT) are named in a
//    notice and left out.
// 2. The footer line "Data as of ...": on Vercel the Lab runs on its committed snapshot.
// Paper money stays where the Lab keeps it: in this browser tab's sessionStorage.
import { SESSION_KEY } from "../lab-static/session.js";

/** The Lab only restores a basket that was suggested with 7 to 10 candidates. */
const MIN_CANDIDATES = 7;
const MAX_SYMBOLS = 10;
const MAX_IDEA_LENGTH = 500;
const DEFAULT_IDEA = "Basket from AI research";

/**
 * Reads the hand-off from a query string. Null when there is no `symbols` parameter.
 * @param {string} search  e.g. "?symbols=NVDA,TSM&idea=AI%20chips"
 * @returns {{ symbols: string[], idea: string } | null}
 */
export function parseHandoff(search) {
  const params = new URLSearchParams(search);
  const raw = params.get("symbols");
  if (raw === null) return null;
  const symbols = raw
    .split(",")
    .map((symbol) => symbol.trim().toUpperCase())
    .filter((symbol) => /^[A-Z][A-Z.]{0,5}$/.test(symbol));
  return {
    symbols: [...new Set(symbols)].slice(0, MAX_SYMBOLS),
    idea: (params.get("idea") ?? "").trim().slice(0, MAX_IDEA_LENGTH),
  };
}

/**
 * Turns handed-over symbols into a basket in the Lab's session format.
 * @param {{ symbols: string[], idea: string }} handoff
 * @param {{ symbol: string, name: string, lastClose?: unknown }[]} catalog  the stocks of GET /api/lab/overview
 * @returns {{ basket: { symbols: string[], candidates: { symbol: string, name: string }[] } | null, tradable: string[], untradable: string[] }}
 */
export function buildHandoff(handoff, catalog) {
  const priced = new Map(
    catalog.filter((stock) => stock.lastClose != null).map((stock) => [stock.symbol, stock]),
  );
  const tradable = handoff.symbols.filter((symbol) => priced.has(symbol));
  const untradable = handoff.symbols.filter((symbol) => !priced.has(symbol));
  if (!tradable.length) return { basket: null, tradable, untradable };

  const candidates = tradable.map((symbol) => ({ symbol, name: priced.get(symbol).name }));
  // The Lab's session format needs at least 7 candidates. The extra ones are never holdings and
  // are not in `removed`, so they cannot appear in the basket, in Undo or in an export.
  for (const stock of priced.values()) {
    if (candidates.length >= MIN_CANDIDATES) break;
    if (!tradable.includes(stock.symbol))
      candidates.push({ symbol: stock.symbol, name: stock.name });
  }
  return {
    basket: {
      version: 2,
      idea: handoff.idea || DEFAULT_IDEA,
      candidates,
      symbols: tradable,
      removed: [],
      // The symbols were picked by the Gemini agent on the AI page.
      source: "gemini",
      summary: DEFAULT_IDEA,
      paperAmountCents: 0,
    },
    tradable,
    untradable,
  };
}

/** The notice shown above the Lab after a hand-off. */
export function handoffNotice({ basket, tradable, untradable }) {
  if (!basket) {
    return untradable.length
      ? `None of these can be paper-traded in the Lab yet: ${untradable.join(", ")}.`
      : "No stock symbols were handed over.";
  }
  return (
    `Loaded ${tradable.join(", ")} from AI research.` +
    (untradable.length ? ` Not tradable in the Lab yet: ${untradable.join(", ")}.` : "")
  );
}

function showNotice(result) {
  const box = document.getElementById("lab-handoff");
  if (!box) return;
  box.textContent = handoffNotice(result);
  if (!result.basket) {
    const back = document.createElement("a");
    back.href = "/";
    back.textContent = "← Back to AI research";
    box.append(" ", back);
  } else {
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "×";
    close.setAttribute("aria-label", "Dismiss");
    close.addEventListener("click", () => {
      box.hidden = true;
    });
    box.append(close);
  }
  box.hidden = false;
}

async function run() {
  let overview;
  try {
    const response = await fetch("/api/lab/overview");
    if (!response.ok) return;
    overview = await response.json();
  } catch {
    return; // The Lab shows its own error for the same failed request.
  }

  const asOf = document.getElementById("lab-data-as-of");
  if (asOf && overview.builtAt) {
    const when = new Date(overview.builtAt).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZone: "America/New_York",
    });
    asOf.textContent = `Data as of ${when} ET (a saved snapshot of prices and event odds).`;
    asOf.hidden = false;
  }

  const handoff = location.pathname === "/lab/basket" ? parseHandoff(location.search) : null;
  if (!handoff) return;
  const result = buildHandoff(handoff, Array.isArray(overview.stocks) ? overview.stocks : []);
  if (result.basket) {
    try {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify(result.basket));
    } catch {
      return; // No session storage: the Lab opens on its idea page.
    }
  }
  // The query is used once; a refresh keeps the basket and its paper funds.
  history.replaceState({}, "", "/lab/basket");
  showNotice(result);
}

if (typeof window !== "undefined") await run();
