# MyETF teammate handoff

Team colors: **🟠 Shaun — framework**, **🟣 Kieran — website**,
**🟢 Hao — Polymarket**, and **🔵 Lucas — Google/backend**.

The teammate implementation files listed below are intentionally empty. Fill
them with your code. Shaun's controller, mock services, fixtures, and framework
tests are ready to use. The earlier agent prototype, its tests, and the previous
website were backed up locally before these files were emptied.

This guide describes the root application's starter files. Additional backend
implementations already exist on `main` under `web/` and `backend/src/`.

## Functions: what each person takes and gives

| Owner | Function to implement or provide | TAKE: input | GIVE: output |
| --- | --- | --- | --- |
| 🔵 **Lucas** | **`findStocks({ idea })`** | User's `idea` string | **`{ summary, stocks: [{ symbol, name }] }`** |
| 🟢 **Hao** | **`adjustWeights({ idea, holdings })`** | User's idea and selected `{ symbol, weightPct }` holdings | **`{ status, holdings, explanation, evidence }`** |
| 🟣 **Kieran** | **`render(state)`** in `js/ui.js` | Controller snapshots, including `stocks`, current `holdings`, `status`, and `error` | **Updated website DOM** showing names, tickers, percentages, loading, or errors |
| 🟠 **Shaun** | **`createController({ findStocks, adjustWeights })`**, already implemented | Lucas's and Hao's async functions | **Controller methods and state snapshots** for Kieran |

Kieran sends the user's idea through **`controller.submitIdea(text)`** and
receives updated snapshots through **`controller.subscribe(render)`**.
Both service functions also accept an optional second argument **`{ signal }`**.

```mermaid
flowchart TB
  Kieran["<b>Kieran — website</b><br/><b>render(state)</b><br/>TAKE: state snapshot<br/>GIVE: basket on screen"]
  Shaun["<b>Shaun — framework</b><br/><b>createController(...)</b><br/>TAKE: findStocks + adjustWeights<br/>GIVE: controller + state snapshots"]
  Lucas["<b>Lucas — Google/backend</b><br/><b>findStocks({ idea })</b><br/>TAKE: idea<br/>GIVE: summary + stocks"]
  Hao["<b>Hao — Polymarket</b><br/><b>adjustWeights({ idea, holdings })</b><br/>TAKE: idea + holdings<br/>GIVE: status + holdings + explanation + evidence"]
  Kieran -->|submitIdea text| Shaun
  Shaun -->|subscribe render: state| Kieran
  Shaun -->|idea| Lucas
  Shaun -->|idea + holdings| Hao
  classDef lucas fill:#dbeafe,stroke:#2563eb,color:#172554
  classDef hao fill:#dcfce7,stroke:#16a34a,color:#14532d
  classDef kieran fill:#ede9fe,stroke:#7c3aed,color:#3b0764
  classDef shaun fill:#ffedd5,stroke:#ea580c,color:#7c2d12
  class Lucas lucas
  class Hao hao
  class Kieran kieran
  class Shaun shaun
```

## File ownership

All paths below are relative to the repository root (`app/` on Shaun's computer).

| Owner | Empty file | Put this code here |
| --- | --- | --- |
| 🔵 Lucas — Google/backend | `agent/gemini.js` | One Gemini agent with retrieval, tools, and memory; export `findStocks` |
| 🔵 Lucas — Google/backend | `agent/tools.js` | Tool declarations, argument checks, and tool execution |
| 🔵 Lucas — Google/backend | `agent/retrieval.js` | Retrieve project context for the agent |
| 🔵 Lucas — Google/backend | `agent/project-notes.json` | Valid JSON containing project context and output rules |
| 🔵 Lucas — Google/backend | `agent/memory.js` | Session-scoped preferences and previous baskets |
| 🔵 Lucas — Google/backend | `agent/basket.js` | Optional helper for an initial display basket; reuse `startingWeights` from `js/controller.js` |
| 🔵 Lucas — Google/backend | `agent/run.js` | Optional local CLI for trying the agent |
| 🔵 Lucas — Google/backend | `backend/server.js` | HTTP server exposing both API routes below |
| 🔵 Lucas — Google/backend | `js/stock-api.js` | Browser `findStocks` adapter calling `POST /api/stocks` |
| 🟢 Hao — Polymarket | `polymarket/weights.js` | Market lookup and weighting formula; export `adjustWeights` |
| 🟢 Hao — Polymarket | `js/weights-api.js` | Browser `adjustWeights` adapter calling `POST /api/weights` |
| 🟣 Kieran — website | `index.html` | Chat intake and basket dashboard markup |
| 🟣 Kieran — website | `css/styles.css` | Website styling and responsive layout |
| 🟣 Kieran — website | `js/ui.js` | Render controller snapshots; show names, tickers, and percentages |
| 🟣 Kieran — website | `js/app.js` | Connect UI events, controller, and both API adapters |
| 🟣 Kieran — website | `js/config.js` | Export `API_BASE_URL`, provided by Lucas |

Keep the shared `js/controller.js`, `js/services.js`, and `data/chat-demo.json`
available. Coordinate any changes to these shared contracts with Shaun.

## 🔵 Lucas — Google/backend: take an idea, give selected companies

**FUNCTION TO EXPORT: `findStocks({ idea }, { signal } = {})`**

**TAKE:** `{ idea: string }`.

**GIVE:** `{ summary: string, stocks: [{ symbol: string, name: string }] }`.

Implement the server-side function in `agent/gemini.js`:

```js
export async function findStocks({ idea }, { signal } = {}) { /* your code */ }
```

Expose it through `POST /api/stocks` in `backend/server.js`.

Request body:

```json
{ "idea": "I care about clean energy" }
```

Response body:

```json
{
  "summary": "Your clean energy basket",
  "stocks": [
    { "symbol": "AAA", "name": "Company A" },
    { "symbol": "BBB", "name": "Company B" },
    { "symbol": "CCC", "name": "Company C" }
  ]
}
```

The names and tickers are placeholders. Find three actual companies with unique
symbols. Use a short summary; return no `reason` or `research` fields. Keep Google
credentials on the backend. `agent/.env.example` remains a configuration template;
local `.env` files are ignored by Git. Provide Kieran with the
backend base URL and configure CORS for the website origin.

The browser adapter in `js/stock-api.js` must export the same `findStocks`
signature, send `{ idea }` to the endpoint, forward `signal` to `fetch`, and
return the response JSON. Reject failures instead of substituting demo companies.

The shared controller assigns equal starting weights: 33.33%, 33.33%, 33.34%.
An additional `basket` field is optional; the controller uses `summary` and
`stocks`, so those fields must remain available.

## 🟢 Hao — Polymarket: take selected holdings, give their weights

**FUNCTION TO EXPORT: `adjustWeights({ idea, holdings }, { signal } = {})`**

**TAKE:** `{ idea: string, holdings: [{ symbol: string, weightPct: number }] }`.

**GIVE:** `{ status: "adjusted" | "unchanged", holdings, explanation: string, evidence: [] }`.
`evidence` contains actual market items when present; the item fields are shown below.

Implement the server-side function in `polymarket/weights.js`:

```js
export async function adjustWeights({ idea, holdings }, { signal } = {}) { /* your code */ }
```

Lucas imports this function into `backend/server.js` and exposes
it through `POST /api/weights`. Hao owns the market matching
and weighting formula, and supplies the browser adapter in `js/weights-api.js`.

Request body:

```json
{
  "idea": "I care about clean energy",
  "holdings": [
    { "symbol": "AAA", "weightPct": 33.33 },
    { "symbol": "BBB", "weightPct": 33.33 },
    { "symbol": "CCC", "weightPct": 33.34 }
  ]
}
```

Illustrative response body:

```json
{
  "status": "adjusted",
  "holdings": [
    { "symbol": "AAA", "weightPct": 50 },
    { "symbol": "BBB", "weightPct": 30 },
    { "symbol": "CCC", "weightPct": 20 }
  ],
  "explanation": "Brief adjustment note.",
  "evidence": [
    {
      "title": "Example market",
      "url": "https://example.com/market",
      "outcome": "Yes",
      "probability": 0.6,
      "observedAt": "2026-10-10T12:00:00Z"
    }
  ]
}
```

The percentages and market values above are placeholders. Return exactly the
input symbols once each, with numeric weights from 0 to 100 totaling 100%.
Include actual market evidence for live adjustments. Probabilities range from
0 to 1; `observedAt` is an ISO timestamp. If no relevant market exists, return
`status: "unchanged"`, the original weights, a short explanation, and `evidence: []`.

The browser adapter in `js/weights-api.js` exports the same `adjustWeights`
signature, sends `{ idea, holdings }`, forwards `signal`, and returns the JSON.
Rejected or invalid adjustments cause the controller to retain equal weights.
The website's main basket view need not display `explanation` or `evidence`.

Both HTTP endpoints return non-2xx responses on failure, with a readable
`{ "error": "Message to display" }` body. Both browser adapters import
`API_BASE_URL` from `js/config.js` and reject failed requests with that message.

## 🟣 Kieran — website: connect the functions and show the basket

**FUNCTION TO EXPORT: `render(state)` from `js/ui.js`**.

**TAKE:** the snapshot supplied by **`controller.subscribe(render)`**. It includes
`view`, `status`, `idea`, `stocks`, `holdings`, `adjustment`, and `error`.

**GIVE:** updates to the website DOM; `render` returns no API JSON.

**SEND USER INPUT:** call **`controller.submitIdea(text)`** from the submit/Enter
handler in `js/app.js`. This starts the selection and adjustment flow.

In `js/app.js`, import `createController` from `./controller.js`, `findStocks`
from `./stock-api.js`, `adjustWeights` from `./weights-api.js`, and `render`
from `./ui.js`. Construct:

```js
const controller = createController({ findStocks, adjustWeights });
controller.subscribe(render);
```

Wire submit/Enter to `controller.submitIdea(text)`, edit to
`controller.editIdea()`, and reset to `controller.reset()`. Use `setView(view)`
if you add chat/dashboard navigation. Subscribe to snapshots for loading,
errors, and results; avoid calling the API adapters directly from UI events.

Show the initial chat input. During `finding`, show loading. When the dashboard
opens, join company names from `state.stocks` with **current** percentages from
`state.holdings`, using `symbol`. Show the basket title, company names, tickers,
percentages, and allocation chart. During `adjusting`, keep the starting basket
visible. After `ready`, render the latest percentages. Display user/service text
as text, and preserve the idea when showing a retry error.

See [Website basket example](docs/website-basket.md) for the display shape.

For UI development before live APIs are ready, use the existing mock services:

```js
import { createMockServices } from "./services.js";
const controller = createController(createMockServices());
```

## 🟠 Shaun — framework: provide the shared controller

The following functions in `js/controller.js` are already implemented:

| Function | TAKE: input | GIVE: output |
| --- | --- | --- |
| **`createController({ findStocks, adjustWeights })`** | Both async service functions | Controller object with the methods below |
| **`startingWeights(stocks)`** | Selected stock identities | `{ symbol, weightPct }` holdings with equal starting weights totaling 100% |
| **`controller.subscribe(render)`** | Kieran's render callback | An unsubscribe function; immediately and subsequently calls `render(state)` with snapshots |
| **`controller.getState()`** | No arguments | A copy of the current snapshot |
| **`controller.submitIdea(text)`** | User's idea string | A promise completing the flow; data arrives through snapshots |
| **`controller.editIdea()`** | No arguments | Clears the basket, preserves the idea, and emits updated state |
| **`controller.reset()`** | No arguments | Clears the session and emits updated state |
| **`controller.setView(view)`** | `"chat"` or `"dashboard"` | Updates the view and emits state; dashboard requires selected stocks |

## Current checks

Run `npm test` for the shared framework/calculation checks and
`npm run demo:framework -- "I care about clean energy"` for the mock flow.
The earlier agent prototype tests are in Shaun's local backup, outside this
repository. Add or restore appropriate agent/API checks when implementing them.

`npm start` serves the website files; the page is empty until the website
teammate implements them. No live endpoint or deployment is supplied by these
empty files. Coordinate backend hosting and the website publishing manifest
after the implementation is ready.
