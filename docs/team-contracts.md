# Team ownership and service contracts

| Owner | Owns | Handoff |
| --- | --- | --- |
| Shaun — framework | Controller, mocks, validation, framework tests, architecture docs | Working flow with stable service ports and state snapshots |
| Website teammate | All screen markup, styling, rendering, accessibility, navigation, and app wiring | Use controller snapshots and methods; preserve the service ports |
| Google API teammate | Backend Gemini calls, stock verification, frontend stock adapter | Implement `findStocks` |
| Polymarket teammate | Relevant market matching, weighting methodology, frontend weighting adapter | Implement `adjustWeights` |

Framework files are `js/controller.js`, `js/services.js`, the demo fixtures, and the CLI demo/tests. The website teammate owns `index.html`, `css/styles.css`, `js/ui.js`, `js/app.js`, and browser routing. This framework PR leaves those website files at the shared main baseline. Real stock and weighting adapters should live in separate modules owned by their teammates; coordinate adapter imports in `js/app.js` with the website teammate. Use separate feature branches and PRs into `main`.

## Stock selection port

```js
async function findStocks({ idea }, { signal } = {}) {
  // Return this shape, or reject on a network/service/validation failure.
  return {
    summary: "An explanation of how the idea maps to the companies.",
    stocks: [
      { symbol: "SOLAR_DEMO", name: "Sunbeam Solar", reason: "Fictional solar example." },
      { symbol: "TIDAL_DEMO", name: "Tidal Power", reason: "Fictional renewable example." },
      { symbol: "GRID_DEMO", name: "Evergreen Grid", reason: "Fictional storage example." }
    ]
  };
}
```

The idea is a trimmed, nonempty string. Preserve its original language. Return a nonempty stock array with unique symbols and nonempty names/reasons. The framework assigns equal weights, so this port must not invent allocation percentages or prices. Demo adapters return three companies; the controller can accept another nonzero count. Live symbol/exchange verification and Gemini prompt design belong to the API teammate.

## Percentage adjustment port

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

For a relevant real market, evidence items have `{ title, url, outcome, probability, observedAt }`: probability is a number from 0 to 1, URL is HTTP(S), and observation time is an ISO timestamp. These are event probabilities, not probabilities of stock returns. The Polymarket teammate owns the mapping and explanation. Do not implement that methodology in the controller.

Return exactly the input symbols, once each, with finite numeric weights between 0 and 100 totaling 100% within 0.01 percentage points. Ordering may differ; the controller restores input order and normalizes a tolerated rounding difference. `unchanged` must return the original weights and explain the lack of a relevant adjustment. Return `evidence: []` when none exists; never fabricate markets. Invalid responses or rejected promises keep the starting basket and show an unavailable explanation.

Both functions accept an optional second argument `{ signal }`. Forward it to `fetch` to cancel obsolete requests. The controller also ignores obsolete responses independently. Backend adapters should reject on HTTP errors, timeouts, and invalid JSON; never silently substitute demo data for failed live calls.

## Suggested backend bridge

The controller depends on JavaScript functions, not a hosting provider. The API teammate can implement `POST /api/stocks` with body `{ idea }`; the weighting teammate can implement `POST /api/weights` with body `{ idea, holdings }`. Return the corresponding port response directly as JSON. Use non-2xx responses for failures.

GitHub Pages serves static frontend files only. A live backend needs a separate deployment; configure its base URL in the adapter and CORS for the site origin. Keep Google credentials on that backend, out of client code and commits. No backend provider or live deployment is introduced by this framework.

## Acceptance checklist

- Website: first screen has only the chat intake, no dashboard controls; Enter submits; focus follows screen changes; layouts fit desktop and phone.
- Google adapter: sample ideas produce verified stock identities and reasons using the exact port shape; unsupported inputs and service failures are handled explicitly.
- Polymarket adapter: provide a reviewed methodology, relevant evidence when present, normalized weights, and an unchanged response when no relevant markets exist.
- Framework: tests cover flow, retry, duplicate submission, validation, baseline fallback, cancellation, and stale responses. Existing calculation tests keep passing.

Run `npm test` and `npm run demo:framework -- "I care about clean energy"` to exercise the framework without a website. `npm start` previews only the existing portfolio website until the website teammate connects the framework. That teammate must update the publishing manifest to include `js/controller.js`, `js/services.js`, `data/chat-demo.json`, and any new runtime files their website imports. After review and merge, `python3 scripts/publish_pages.py` publishes the committed main website. Do not deploy unmerged local work using that script.
