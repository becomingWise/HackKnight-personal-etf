# ProphETF backend API

Backend owner: Lucas. Frontend owner: teammate. Every endpoint the frontend can call is documented here
with request and response examples.

Status legend: **LIVE** (deployed), **BUILT** (works locally), **DRAFT** (contract not confirmed yet).

---

## 1. `findStocks` — DRAFT, blocked on the open questions below

### Where the contract comes from

Read from `origin/lucas-branch` (same tree as `origin/main` at `cd8f130`):

| File                       | What it says                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `docs/team-contracts.md`   | The "Stock selection port" and the "Suggested backend bridge"                              |
| `js/controller.js`         | The only caller: `await findStocks({ idea }, { signal })`, then `validateStocks(response)` |
| `js/services.js`           | The mock implementation (reads `data/chat-demo.json`)                                      |
| `tests/controller.test.js` | Behaviour on errors, duplicates, malformed responses                                       |

There is **no HTTP call to findStocks anywhere in the repo yet**. `findStocks` is a JavaScript function
("port") injected into `createController({ findStocks, adjustWeights })`. Today only the mock exists. The
HTTP path is a suggestion in the docs, not something the frontend already calls.

### Contract as written by the framework

**Function signature (frontend side)**

```js
async function findStocks({ idea }, { signal } = {}) → { summary, stocks }
```

**Suggested HTTP bridge** (`docs/team-contracts.md`, "Suggested backend bridge")

|                 |                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Method and path | `POST /api/stocks`                                                                                                       |
| Request headers | `Content-Type: application/json`                                                                                         |
| Request body    | `{ "idea": string }` — trimmed, non-empty, any language                                                                  |
| Success         | `200` with the port response directly as JSON (no envelope)                                                              |
| Failure         | Any non-2xx status. The adapter must reject; the controller then shows "I couldn't build your basket. Please try again." |

**Success response — exactly what the controller reads**

```json
{
  "summary": "An explanation of how the idea maps to the companies.",
  "stocks": [
    { "symbol": "SOLAR_DEMO", "name": "Sunbeam Solar", "reason": "Fictional solar example." },
    { "symbol": "TIDAL_DEMO", "name": "Tidal Power", "reason": "Fictional renewable example." },
    { "symbol": "GRID_DEMO", "name": "Evergreen Grid", "reason": "Fictional storage example." }
  ]
}
```

| Field             | Type   | Rule enforced by `validateStocks` in `js/controller.js`              |
| ----------------- | ------ | -------------------------------------------------------------------- |
| `summary`         | string | Must be a string (shown to the user as the assistant's chat message) |
| `stocks`          | array  | Must be a non-empty array                                            |
| `stocks[].symbol` | string | Non-empty after trim; **unique** across the array                    |
| `stocks[].name`   | string | Non-empty after trim                                                 |
| `stocks[].reason` | string | Non-empty after trim                                                 |

Rules from the contract text:

- "The framework assigns equal weights, so this port **must not invent allocation percentages or prices**."
- "Preserve its original language" (the idea).
- Demo adapters return three companies; "the controller can accept another nonzero count".
- "never silently substitute demo data for failed live calls" — reject instead.
- Any extra field is **dropped**: the controller copies only `symbol`, `name`, `reason` per stock and
  `summary` from the top level. Extra fields are harmless but never reach the UI.

**Error response**: the contract only says "non-2xx". The body is unspecified. Proposed (frontend can ignore it):

```json
{ "error": { "code": "invalid_request", "message": "idea must be a non-empty string" } }
```

| Status | When                                                   |
| ------ | ------------------------------------------------------ |
| 400    | Body is not JSON, or `idea` missing / empty / too long |
| 429    | Per-IP rate limit hit (`Retry-After` header set)       |
| 502    | Gemini and the fallback both failed                    |

### What happens to the response afterwards (why the symbols matter)

1. The controller gives the stocks equal weights.
2. It calls `adjustWeights({ idea, holdings: [{ symbol, weightPct }] })`.
3. The teammate's Python service (`backend/`, FastAPI, `POST /api/weights`) tilts the weights using live
   Polymarket odds. It can only tilt symbols that have a β in `backend/src/polyslice_api/data/universe.json`:
   40 real US tickers in 7 sectors (semis, bigtech, energy, defense, financials, crypto, rates), linked to
   11 Polymarket signals. Any other symbol comes back `unchanged`.

So Polymarket already enters the flow in step 3, through stock tickers.

### Where the frontend is served from (CORS origins)

| Origin                                           | Source                                                                                                   |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| `https://becomingwise.github.io`                 | GitHub Pages site `https://becomingwise.github.io/HackKnight-personal-etf/` (`scripts/publish_pages.py`) |
| `http://localhost:8000`, `http://127.0.0.1:8000` | `npm start` (python http.server)                                                                         |
| `http://localhost:3000`, `http://127.0.0.1:3000` | Also allowed by the Python backend's default CORS list                                                   |

The browser will send an `OPTIONS` preflight (JSON `POST` across origins), so the route must answer it.

### Open questions (blocking)

1. **Stocks or Polymarket markets?** The contract returns companies (`symbol`, `name`, `reason`). The new
   instructions describe findstock as returning Polymarket markets with side, weight and price. These do not
   fit together: the controller drops side/weight/price, the contract forbids weights and prices, and a
   market ID as `symbol` would always come back `unchanged` from `/api/weights`.
2. **Path.** `POST /api/stocks` (the documented suggestion), or a different path such as `/api/findstock`?
3. **Who writes the browser adapter?** Nothing in `js/` calls the backend yet. The contract assigns the
   "frontend stock adapter" to the API teammate (Lucas), but the new split says not to touch frontend code.
4. **Which symbols are allowed?** Only the 40 tickers the weighting backend knows (every pick can be
   tilted), or any real US ticker Gemini suggests (broader, but most will come back `unchanged`)?
5. **How many stocks?** The mock returns 3. Proposed: 3 to 5.

---

## 2. `GET /api/health` — BUILT

No parameters. `200` when the database is reachable, `503` otherwise.

```json
{
  "ok": true,
  "time": "2026-10-09T22:52:44.360Z",
  "database": {
    "ok": true,
    "latency_ms": 69.9,
    "postgres": "18.6",
    "timescaledb": "2.30.2",
    "migrations": 1
  },
  "sponsors": {
    "tiger": { "enabled": true, "configured": true, "mode": "live" },
    "gemini": { "enabled": true, "configured": true, "mode": "live" },
    "snowflake": { "enabled": false, "configured": false, "mode": "mock" }
  }
}
```

`sponsors` has one entry each for `tiger`, `gemini`, `snowflake`, `elevenlabs`, `solana`, `presage`, `ws`.

---

## 3. Existing endpoint owned by the Polymarket teammate (Python, not this app)

`POST /api/weights` on the FastAPI service in `/backend` (local port 8001). See `backend/README.md`.
Listed here only because `findStocks` output feeds it.
