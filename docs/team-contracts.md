# Team ownership and service contracts

| Owner | Owns | Handoff |
| --- | --- | --- |
| 🟠 Shaun — framework | Controller, mocks, validation, framework tests, architecture docs | Working flow with stable service ports and state snapshots |
| 🟣 Kieran — website | All screen markup, styling, rendering, accessibility, navigation, and app wiring | Use controller snapshots and methods; preserve the service ports |
| 🔵 Lucas — Google/backend | `agent/gemini.js`, agent helpers, `backend/server.js`, `js/stock-api.js` | Implement `findStocks` and expose both HTTP routes |
| 🟢 Hao — Polymarket | `polymarket/weights.js`, `js/weights-api.js` | Implement `adjustWeights` |

Framework files are `js/controller.js`, `js/services.js`, the demo fixtures, and the CLI demo/tests. Kieran owns `index.html`, `css/styles.css`, `js/ui.js`, `js/app.js`, `js/config.js`, and browser routing. Teammate implementation files are intentionally empty. The previous implementation was backed up locally. Read [Teammate handoff](../TEAM_HANDOFF.md) for the complete file map, and coordinate adapter imports in `js/app.js` with Kieran.

## 🔵 Lucas: `findStocks` — stock selection

**TAKE:** `{ idea }`, plus optional `{ signal }` as the second argument.

**GIVE:** `{ summary, stocks: [{ symbol, name }] }`.

```js
async function findStocks({ idea }, { signal } = {}) {
  // Return this shape, or reject on a network/service/validation failure.
  return {
    summary: "Three companies matching your idea.",
    stocks: [
      { symbol: "SOLAR_DEMO", name: "Sunbeam Solar" },
      { symbol: "TIDAL_DEMO", name: "Tidal Power" },
      { symbol: "GRID_DEMO", name: "Evergreen Grid" }
    ]
  };
}
```

The idea is a trimmed, nonempty string. Preserve its original language. Return a nonempty stock array with unique symbols and nonempty names. Each stock contains only `symbol` and `name`; exclude `reason` and `research` from the response. The framework assigns equal weights, so this port must not invent allocation percentages or prices. Demo adapters return three companies; the controller can accept another nonzero count. Live symbol/exchange verification and Gemini prompt design belong to Lucas.

Lucas may also supply a display-ready `basket` field with company
names, symbols, and equal starting percentages computed by application code.
The controller requires `summary` and `stocks` even when `basket` is included.
The website should show company names, tickers, and allocations; selection
explanations are not required on the main basket screen. If using the controller,
render names from `state.stocks` and current percentages from `state.holdings`
so later adjustments are reflected. See [Website basket handoff](website-basket.md)
for the exact payload and rendering example.

## 🟢 Hao: `adjustWeights` — percentage adjustment

**TAKE:** `{ idea, holdings: [{ symbol, weightPct }] }`, plus optional `{ signal }`.

**GIVE:** `{ status, holdings, explanation, evidence }`.

```js
async function adjustWeights({ idea, holdings }, { signal } = {}) {
  // Input holdings: [{ symbol, weightPct }], initially equal and totaling 100%.
  return {
    status: "adjusted", // or "unchanged"
    holdings: [
      { symbol: "SOLAR_DEMO", weightPct: 50 },
      { symbol: "TIDAL_DEMO", weightPct: 30 },
      { symbol: "GRID_DEMO", weightPct: 20 }
    ],
    explanation: "Illustrative response shape; these are not market-derived weights.",
    evidence: []
  };
}
```

For a relevant real market, evidence items have `{ title, url, outcome, probability, observedAt }`: probability is a number from 0 to 1, URL is HTTP(S), and observation time is an ISO timestamp. These are event probabilities, not probabilities of stock returns. Hao owns the mapping and explanation. Do not implement that methodology in the controller.

Return exactly the input symbols, once each, with finite numeric weights between 0 and 100 totaling 100% within 0.01 percentage points. Ordering may differ; the controller restores input order and normalizes a tolerated rounding difference. `unchanged` must return the original weights and explain the lack of a relevant adjustment. Return `evidence: []` when none exists; never fabricate markets. Invalid responses or rejected promises keep the starting basket and show an unavailable explanation.

Both functions accept an optional second argument `{ signal }`. Forward it to `fetch` to cancel obsolete requests. The controller also ignores obsolete responses independently. Backend adapters should reject on HTTP errors, timeouts, and invalid JSON; never silently substitute demo data for failed live calls.

## Suggested backend bridge

The controller depends on JavaScript functions, not a hosting provider. In `backend/server.js`, Lucas exposes `POST /api/stocks` with body `{ idea }` and `POST /api/weights` with body `{ idea, holdings }`. The latter calls Hao's `adjustWeights` export from `polymarket/weights.js`. Return the corresponding port response directly as JSON. Use non-2xx responses with `{ error: "Readable message" }` for failures. The browser adapters in `js/stock-api.js` and `js/weights-api.js` import `API_BASE_URL` from `js/config.js` and reject failed requests.

GitHub Pages serves static frontend files only. A live backend needs a separate deployment; configure its base URL in the adapter and CORS for the site origin. Keep Google credentials on that backend, out of client code and commits. No backend provider or live deployment is introduced by this framework.

## Acceptance checklist

- Kieran (website): first screen has only the chat intake, no dashboard controls; Enter submits; focus follows screen changes; layouts fit desktop and phone.
- Lucas (Google/backend): sample ideas produce verified stock names and symbols using the exact port shape; unsupported inputs and service failures are handled explicitly.
- Hao (Polymarket): provide a reviewed methodology, relevant evidence when present, normalized weights, and an unchanged response when no relevant markets exist.
- Shaun (framework): tests cover flow, retry, duplicate submission, validation, baseline fallback, cancellation, and stale responses. Existing calculation tests keep passing.

Run `npm test` and `npm run demo:framework -- "I care about clean energy"` to exercise the framework without a website. `npm start` serves an empty page until Kieran fills the website files and connects the framework. That teammate must update the publishing manifest to include the browser runtime modules it imports. Coordinate publishing after implementation, review, and merge; the empty files are not a finished website.
