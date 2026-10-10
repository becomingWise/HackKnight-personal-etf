# ProphETF backend API

Backend owner: Lucas. Frontend owner: teammate. Every endpoint the frontend can call is documented here
with request and response examples.

**Base URL (production):** `https://prophetf.vercel.app`
**Local:** `http://localhost:3000` (`pnpm dev` in `/web`)

Status legend: **LIVE** (deployed), **BUILT** (works locally), **DRAFT** (contract not confirmed yet).

Errors on every endpoint use a non-2xx status and this body:

```json
{ "error": { "code": "invalid_request", "message": "idea must be a non-empty string" } }
```

---

## 1. `findStocks` — LIVE

`POST /api/stocks` (alias: `POST /api/findstock`, identical behaviour)

Implements the "Stock selection port" in `/docs/team-contracts.md`: an idea in, 3 to 5 stocks out. Gemini
(`gemini-3.5-flash`) picks the stocks and writes each reason from live Polymarket odds.

### Request

|         |                                                                   |
| ------- | ----------------------------------------------------------------- |
| Headers | `Content-Type: application/json`                                  |
| Body    | `{ "idea": string }` — trimmed, 1 to 500 characters, any language |

```json
{ "idea": "AI chips and Taiwan risk" }
```

### Success response — `200`

```json
{
  "summary": "This portfolio targets leading semiconductor companies exposed to the AI chip supply chain and geopolitical risk around Taiwan. Key Polymarket odds: \"Will China invade Taiwan by December 31, 2027?\" 11%; \"Will AI-chip export licensing become law this year?\" 21%.",
  "stocks": [
    {
      "symbol": "TSM",
      "name": "Taiwan Semiconductor",
      "reason": "Polymarket gives 11% that China will invade Taiwan by December 31, 2027, which matters for TSM because its advanced fabs are concentrated in Taiwan.",
      "marketId": "1633611"
    },
    {
      "symbol": "NVDA",
      "name": "NVIDIA",
      "reason": "Polymarket gives 21% that AI-chip export licensing will become law this year, which matters for NVDA because it is the leading designer of AI processors subject to trade restrictions.",
      "marketId": "1426260"
    },
    {
      "symbol": "INTC",
      "name": "Intel",
      "reason": "Intel is building domestic foundry capacity that benefits from reshoring.",
      "marketId": null
    }
  ],
  "source": "gemini",
  "markets": [
    {
      "id": "1633611",
      "title": "Will China invade Taiwan by December 31, 2027?",
      "url": "https://polymarket.com/event/will-china-invade-taiwan-by-december-31-2027",
      "outcome": "Yes",
      "probability": 0.105,
      "observedAt": "2026-10-10T00:34:53.768Z"
    }
  ]
}
```

**Contract fields** (what `validateStocks` in `/js/controller.js` reads):

| Field             | Type   | Guarantee                                                                                                                              |
| ----------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `summary`         | string | Non-empty. How the idea maps to the companies, ending with the key Polymarket odds when markets were cited. Same language as the idea. |
| `stocks`          | array  | 3 to 5 items, unique symbols                                                                                                           |
| `stocks[].symbol` | string | One of the 40 tickers in the weighting backend's `universe.json`, so `POST /api/weights` can tilt every pick                           |
| `stocks[].name`   | string | Company name from `universe.json`                                                                                                      |
| `stocks[].reason` | string | Non-empty. Cites a Polymarket market and its current odds when one is relevant                                                         |

No allocation percentages, weights or stock prices are ever returned, per the contract.

**Extra fields** (optional to use; the controller ignores them):

| Field               | Type                       | Meaning                                                                                                                                                                            |
| ------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stocks[].marketId` | string \| null             | The Polymarket market the reason cites; matches a `markets[].id`. `null` when no live market was relevant                                                                          |
| `source`            | `"gemini"` \| `"fallback"` | `"fallback"` = Gemini failed or timed out and stocks were chosen by keyword. The summary says so too                                                                               |
| `markets`           | array                      | The cited markets, in the same shape as the `evidence` items of `adjustWeights`: `id`, `title`, `url`, `outcome` (always `"Yes"`), `probability` (0 to 1), `observedAt` (ISO time) |

### Error responses

| Status | `error.code`      | When                                                                                       |
| ------ | ----------------- | ------------------------------------------------------------------------------------------ |
| 400    | `invalid_request` | Body is not JSON, or `idea` is missing, not a string, empty, or longer than 500 characters |
| 429    | `rate_limited`    | Rate limit hit. `Retry-After` header gives the seconds to wait                             |
| 502    | `no_match`        | Gemini is unavailable and no supported stock matched the idea by keyword                   |
| 502    | `upstream_error`  | Unexpected failure                                                                         |

The adapter must reject on any non-2xx status; the controller then shows its own retry message.

### Behaviour

- **Evidence is real.** Candidate markets come from Polymarket's public search (live, unresolved, Yes/No,
  with a real price). A stock whose reason cites a market that was not among the candidates is dropped.
  Odds quoted in a reason are checked against the live price (within 1 point) and rewritten if wrong.
- **Timing.** Typically 4 to 10 seconds. Gemini has 20 seconds in total, including one retry on invalid
  output; after that the keyword fallback answers in the same shape.
- **Caching.** The same idea returns the cached answer for 10 minutes (per server instance).
- **Rate limits.** 20 requests per minute and 300 per day per IP, 1,500 per day in total.
- **CORS.** Allowed origins: `https://becomingwise.github.io`, `http://localhost:8000`,
  `http://127.0.0.1:8000`, `http://localhost:3000`, `http://127.0.0.1:3000`. `OPTIONS` preflight is
  answered. More origins can be added with the `CORS_ORIGINS` env var (comma-separated).

### Using it from the frontend

`/js/stocks-adapter.js` implements the port. It is not wired into the app; import it where the controller
is created:

```js
import { createController } from "./controller.js";
import { createMockServices } from "./services.js";
import { findStocks } from "./stocks-adapter.js";

const controller = createController({ ...createMockServices(), findStocks });
```

For another backend URL (local development):

```js
import { createFindStocks } from "./stocks-adapter.js";
const findStocks = createFindStocks({ baseUrl: "http://localhost:3000" });
```

If the site is published with `scripts/publish_pages.py`, add `js/stocks-adapter.js` to its manifest.

### Try it

PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri "https://prophetf.vercel.app/api/stocks" -ContentType "application/json" -Body '{"idea":"AI chips and Taiwan risk"}' | ConvertTo-Json -Depth 5
```

curl:

```sh
curl -X POST https://prophetf.vercel.app/api/stocks -H "Content-Type: application/json" -d '{"idea":"AI chips and Taiwan risk"}'
```

Locally without HTTP: `pnpm try:findstocks "your idea"` in `/web`.

---

## 2. `GET /api/health` — LIVE

No parameters. `200` when the database is reachable, `503` otherwise.

```json
{
  "ok": true,
  "time": "2026-10-10T00:38:59.783Z",
  "database": {
    "ok": true,
    "latency_ms": 122.2,
    "postgres": "18.6",
    "timescaledb": "2.30.2",
    "migrations": 2
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

`POST /api/weights` on the FastAPI service in `/backend` (local port 8001). See `/backend/README.md`.
Listed here because `findStocks` output feeds it: it tilts only the 40 tickers in
`/backend/src/polyslice_api/data/universe.json`. After that file changes, run `pnpm sync:universe` in `/web`
and redeploy so both services agree.
