export const GREETING = "What interests or ideas would you like your portfolio to reflect?";

const initialState = () => ({
  view: "chat", status: "idle", idea: "", summary: "",
  messages: [{ role: "assistant", content: GREETING }],
  stocks: [], startingHoldings: [], holdings: [],
  adjustment: { status: "pending", explanation: "", evidence: [] },
  error: null
});
const clone = value => structuredClone(value);

export function startingWeights(stocks) {
  const cents = Math.floor(10000 / stocks.length);
  return stocks.map((stock, index) => ({
    symbol: stock.symbol,
    weightPct: (index === stocks.length - 1 ? 10000 - cents * index : cents) / 100
  }));
}

function validateStocks(response) {
  if (typeof response?.summary !== "string" || !Array.isArray(response.stocks) || !response.stocks.length) {
    throw new Error("The stock service returned an invalid basket.");
  }
  const symbols = new Set();
  return response.stocks.map(stock => {
    if (![stock?.symbol, stock?.name].every(value => typeof value === "string" && value.trim())) {
      throw new Error("Each stock needs a symbol and name.");
    }
    const symbol = stock.symbol.trim();
    if (symbols.has(symbol)) throw new Error("The stock service returned duplicate symbols.");
    symbols.add(symbol);
    return { symbol, name: stock.name.trim() };
  });
}

export function validateAdjustment(response, baseline) {
  if (!["adjusted", "unchanged"].includes(response?.status) ||
      typeof response.explanation !== "string" || !response.explanation.trim() ||
      !Array.isArray(response.evidence) || !Array.isArray(response.holdings) ||
      response.holdings.length !== baseline.length) {
    throw new Error("The weighting service returned an invalid response.");
  }
  const weights = new Map();
  for (const holding of response.holdings) {
    if (!baseline.some(item => item.symbol === holding?.symbol) || weights.has(holding.symbol) ||
        !Number.isFinite(holding.weightPct) || holding.weightPct < 0 || holding.weightPct > 100) {
      throw new Error("Adjusted weights must preserve the selected stocks and valid percentages.");
    }
    weights.set(holding.symbol, holding.weightPct);
  }
  const total = [...weights.values()].reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 100) > 0.010000001) throw new Error("Adjusted weights must total 100%.");
  if (response.status === "unchanged" && baseline.some(item => Math.abs(weights.get(item.symbol) - item.weightPct) > 1e-8)) {
    throw new Error("An unchanged response must preserve the starting percentages.");
  }
  for (const item of response.evidence) {
    let url;
    try { url = new URL(item?.url); } catch { throw new Error("Market evidence needs a valid URL."); }
    if (!["http:", "https:"].includes(url.protocol) ||
        ![item.title, item.outcome, item.observedAt].every(value => typeof value === "string" && value.trim()) ||
        !Number.isFinite(item.probability) || item.probability < 0 || item.probability > 1 ||
        !Number.isFinite(Date.parse(item.observedAt))) {
      throw new Error("Market evidence needs a title, outcome, probability, and observation time.");
    }
  }
  // Normalize tolerated rounding so the internal allocation still totals 100%.
  return {
    status: response.status,
    holdings: baseline.map(item => ({ symbol: item.symbol, weightPct: weights.get(item.symbol) / total * 100 })),
    explanation: response.explanation.trim(), evidence: clone(response.evidence)
  };
}

/** Owns application behavior; inject services to keep DOM and network code outside. */
export function createController({ findStocks, adjustWeights }) {
  let state = initialState();
  let generation = 0;
  let pending = null;
  const listeners = new Set();
  const getState = () => clone(state);
  const emit = () => { for (const listener of listeners) listener(getState()); };
  const cancel = () => { generation += 1; pending?.abort(); pending = null; };

  async function submitIdea(text) {
    if (["finding", "adjusting"].includes(state.status)) return;
    const idea = typeof text === "string" ? text.trim() : "";
    if (!idea) {
      state.error = "Tell me a little about your idea first.";
      emit();
      return;
    }
    cancel();
    const request = generation;
    pending = new AbortController();
    const options = { signal: pending.signal };
    state = { ...initialState(), idea, status: "finding", messages: [
      { role: "assistant", content: GREETING },
      { role: "user", content: idea },
      { role: "assistant", content: "Finding stocks for your idea…" }
    ] };
    emit();
    try {
      const response = await findStocks({ idea }, options);
      if (request !== generation) return;
      const stocks = validateStocks(response);
      const baseline = startingWeights(stocks);
      state = { ...state, view: "dashboard", status: "adjusting", summary: response.summary,
        stocks, startingHoldings: baseline, holdings: clone(baseline),
        messages: [...state.messages.slice(0, -1), { role: "assistant", content: response.summary }],
        adjustment: { status: "pending", explanation: "Checking for a percentage adjustment…", evidence: [] }
      };
      emit();
    } catch {
      if (request !== generation) return;
      state.status = "error";
      state.error = "I couldn’t build your basket. Please try again.";
      state.messages[state.messages.length - 1] = { role: "assistant", content: state.error };
      pending = null;
      emit();
      return;
    }
    if (request !== generation) return;
    try {
      // Give adapters copies so they cannot mutate controller-owned state.
      const response = await adjustWeights({ idea, holdings: clone(state.startingHoldings) }, options);
      if (request !== generation) return;
      const adjustment = validateAdjustment(response, state.startingHoldings);
      state.holdings = adjustment.holdings;
      state.adjustment = { status: adjustment.status, explanation: adjustment.explanation, evidence: adjustment.evidence };
    } catch {
      if (request !== generation) return;
      state.holdings = clone(state.startingHoldings);
      state.adjustment = {
        status: "unavailable", evidence: [],
        explanation: "No adjustment was applied because the weighting service was unavailable or returned invalid data. Your starting percentages are retained."
      };
    }
    state.status = "ready";
    pending = null;
    emit();
  }

  return {
    getState,
    subscribe(listener) {
      listeners.add(listener);
      listener(getState());
      return () => listeners.delete(listener);
    },
    submitIdea,
    editIdea() {
      const idea = state.idea;
      cancel();
      state = { ...initialState(), idea };
      emit();
    },
    reset() { cancel(); state = initialState(); emit(); },
    // Browser navigation changes the view without discarding an existing basket.
    setView(view) {
      state.view = view === "dashboard" && state.stocks.length ? "dashboard" : "chat";
      emit();
    }
  };
}
