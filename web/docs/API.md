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
- **Caching.** Answers are cached in Tiger for 15 minutes, shared by all servers. Ideas that differ only in case, spacing or surrounding punctuation share an entry. The body says so: `"cached": true` with `"cachedAt"` (ISO time the answer was computed), or `"cached": false, "cachedAt": null`. The same is in the headers `X-Cache: HIT|MISS` and `X-Cache-Age` (seconds). Keyword fallbacks are never cached. Cached answers return in about 0.1 s.
- **Model backup.** If `gemini-3.5-flash` is rate limited or overloaded, `gemini-3.5-flash-lite` answers instead (still `"source": "gemini"`); only if both fail does the keyword fallback run.
- **Rate limits.** 30 requests per minute and 600 per day per IP. Requests that are not answered from the cache are also capped at 600 per day in total, to protect the Gemini quota.
- **Gemini quota (free tier, measured 2026-10-09).** `gemini-3.5-flash` allows 5 requests per minute and `gemini-3.5-flash-lite` 15. An uncached idea uses one of each. Up to about 4 new ideas per minute get the main model, up to about 10 are still answered by AI through the backup model, and beyond that the keyword fallback answers. Cached ideas are not limited by this.
- **CORS.** Allowed origins: `https://becomingwise.github.io`, `http://localhost:8000`,
  `http://127.0.0.1:8000`, `http://localhost:3000`, `http://127.0.0.1:3000`. `OPTIONS` preflight is
  answered. More origins can be added with the `CORS_ORIGINS` env var (comma-separated).

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

## 2. `adjustWeights` — LIVE

`POST /api/weights`

Implements the "Percentage adjustment port" in `/docs/team-contracts.md`: tilts a basket's weights by how
much the linked Polymarket odds moved over the past week. Same request and response as the Python service
in `/backend`.

> **The Python engine is the reference.** This endpoint is a TypeScript port of
> `/backend/src/polyslice_api/{engine,main,polymarket}.py`, made so the method has a public URL. Any change
> to the Python method must be mirrored in `/web/src/lib/weights/`, then `pnpm parity:weights` and
> `pnpm test` rerun. The parity tests replay 88 requests through the real Python app and require identical
> statuses, weights, explanations and evidence.

### Request

```json
{
  "idea": "AI chips and Taiwan risk",
  "holdings": [
    { "symbol": "NVDA", "weightPct": 33.33 },
    { "symbol": "TSM", "weightPct": 33.33 },
    { "symbol": "INTC", "weightPct": 33.34 }
  ]
}
```

| Field                  | Type   | Rule                                                               |
| ---------------------- | ------ | ------------------------------------------------------------------ |
| `idea`                 | string | At least 1 character                                               |
| `holdings`             | array  | At least 1 item, unique symbols, weights totalling 100 within 0.01 |
| `holdings[].symbol`    | string | Matched case-insensitively, echoed back exactly as sent            |
| `holdings[].weightPct` | number | 0 to 100                                                           |

### Success response — `200`

```json
{
  "status": "adjusted",
  "holdings": [
    { "symbol": "NVDA", "weightPct": 37.06 },
    { "symbol": "TSM", "weightPct": 32.75 },
    { "symbol": "INTC", "weightPct": 30.19 }
  ],
  "explanation": "Tilted by Polymarket odds moves over the past week: NVDA 33.3% → 37.1% (“Will AI-chip export licensing become law this year?” down 12 pts to 22%); … Event probabilities indicate risk, not expected returns.",
  "evidence": [
    {
      "title": "Will AI-chip export licensing become law this year?",
      "url": "https://polymarket.com/event/which-bills-will-become-law-in-2026",
      "outcome": "Yes",
      "probability": 0.225,
      "observedAt": "2026-10-10T01:16:16.000Z",
      "change7d": -0.125,
      "symbols": ["INTC", "NVDA"]
    }
  ]
}
```

| Field         | Type                          | Guarantee                                                                                                                                    |
| ------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`      | `"adjusted"` \| `"unchanged"` | `unchanged` when no tracked live market is linked to any holding, or the tilt rounds away                                                    |
| `holdings`    | array                         | Exactly the input symbols in the input order; weights rounded to 0.01 and totalling exactly 100. For `unchanged`, the input weights verbatim |
| `explanation` | string                        | Non-empty                                                                                                                                    |
| `evidence`    | array                         | Only real, live markets; `[]` when none is linked. `change7d` (number or null) and `symbols` are extra fields                                |

Passes the controller's `validateAdjustment`. Only the 40 tickers in `universe.json` can be tilted, which
is why `/api/stocks` returns only those.

### Error responses

| Status | When                                                       | Body                                                                                                          |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 422    | Invalid body, duplicate symbols, weights not totalling 100 | `{ "detail": "Duplicate symbols.", "error": { "code": "invalid_request", "message": "Duplicate symbols." } }` |
| 429    | More than 60 requests per minute from one IP               | `Retry-After` header                                                                                          |
| 502    | Polymarket lookup failed                                   |                                                                                                               |

`detail` is the field the Python service returns; `error` is this API's common shape. Same CORS origins as
`/api/stocks`. Live odds are cached for 60 seconds.

Identical requests (same symbols as sent, same weights, same order; the idea text does not matter) are
answered from a 15-minute cache in Tiger. The body carries `"cached": true|false` and `"cachedAt"` (two
fields the Python service does not have), and the headers `X-Cache` and `X-Cache-Age`. A cached answer's
`evidence[].observedAt` is the time the odds were read, up to 15 minutes ago.

### Try it

```powershell
Invoke-RestMethod -Method Post -Uri "https://prophetf.vercel.app/api/weights" -ContentType "application/json" -Body '{"idea":"AI chips and Taiwan risk","holdings":[{"symbol":"NVDA","weightPct":33.33},{"symbol":"TSM","weightPct":33.33},{"symbol":"INTC","weightPct":33.34}]}' | ConvertTo-Json -Depth 5
```

---

## Frontend adapters: switching from mocks to the live backend

Two ready-made modules implement the controller's ports. Neither is wired into the app.

| Port                              | Module                   | Calls                                                                                                                               |
| --------------------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `findStocks`                      | `/js/stocks-adapter.js`  | `POST /api/stocks`                                                                                                                  |
| `adjustWeights`                   | `/js/weights-adapter.js` | `POST /api/weights`                                                                                                                 |
| save / open a basket, odds charts | `/js/baskets-adapter.js` | `POST /api/baskets`, `GET /api/baskets/{id}` (section 3), `GET /api/baskets/{id}/odds`, `GET /api/markets/{id}/history` (section 4) |

**How to switch (5 lines):**

```js
import { createController } from "./controller.js";
import { findStocks } from "./stocks-adapter.js";
import { adjustWeights } from "./weights-adapter.js";

const controller = createController({ findStocks, adjustWeights });
```

1. Replace `createController(createMockServices())` with the lines above where the controller is created.
2. To switch only one port, keep the mock for the other: `createController({ ...createMockServices(), findStocks })`.
3. For a different backend URL (local development): `createFindStocks({ baseUrl: "http://localhost:3000" })` and `createAdjustWeights({ baseUrl: "http://localhost:3000" })`.
4. If the site is published with `scripts/publish_pages.py`, add `js/stocks-adapter.js` and `js/weights-adapter.js` to its manifest.
5. The site must be served from an allowed origin: `https://becomingwise.github.io`, `http://localhost:8000`, `http://127.0.0.1:8000`, `http://localhost:3000` or `http://127.0.0.1:3000` (ask Lucas to add others).

Both adapters forward the controller's `signal` to `fetch` and reject on any non-2xx status, so the
controller's own error and retry handling keeps working. Expect about 4 to 10 seconds for stocks and under
2 seconds for weights.

---

## 3. Saved baskets — LIVE

| Endpoint                | Purpose                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `POST /api/baskets`     | Save a basket; returns it with a short `id` and a share `url`                |
| `GET /api/baskets/{id}` | Load a saved basket                                                          |
| `GET /b/{id}`           | The share URL. Returns the same JSON for now; the page is the frontend's job |

A saved basket never changes. It keeps the idea, summary, stocks, weights, the cited Polymarket markets and
the odds observed when it was created.

### `POST /api/baskets`

Send the `/api/stocks` response and the `/api/weights` response exactly as received. Extra fields are
ignored, so the controller's trimmed-down state works too.

```json
{
  "idea": "AI chips and Taiwan risk",
  "stocks": {
    "summary": "…",
    "stocks": [
      { "symbol": "TSM", "name": "Taiwan Semiconductor", "reason": "…", "marketId": "1633611" }
    ],
    "source": "gemini",
    "markets": [
      {
        "id": "1633611",
        "title": "…",
        "url": "https://polymarket.com/event/…",
        "outcome": "Yes",
        "probability": 0.105,
        "observedAt": "2026-10-10T00:34:53.768Z"
      }
    ]
  },
  "weights": {
    "status": "adjusted",
    "holdings": [{ "symbol": "TSM", "weightPct": 100 }],
    "explanation": "…",
    "evidence": []
  }
}
```

| Field     | Type           | Rule                                                                                                                                                                                                                       |
| --------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idea`    | string         | 1 to 500 characters                                                                                                                                                                                                        |
| `stocks`  | object         | A `/api/stocks` response. Required: `summary`, `stocks[]` with `symbol`, `name`, `reason` (1 to 10 stocks, unique symbols). Optional: `source`, `markets[]`, `stocks[].marketId`                                           |
| `weights` | object \| null | A `/api/weights` response. `holdings` must contain exactly the stock symbols and total 100. `status` may also be `"unavailable"`. Omit or send `null` when the weights step failed: the basket is saved with equal weights |

Body limit: 64 KB.

### Response — `201` (and the body of `GET /api/baskets/{id}`, `200`)

```json
{
  "id": "7fkbjd9w",
  "url": "https://prophetf.vercel.app/b/7fkbjd9w",
  "createdAt": "2026-10-10T01:22:45.855Z",
  "idea": "AI chips and Taiwan risk",
  "summary": "This portfolio targets leading semiconductor companies… Key Polymarket odds: …",
  "source": "gemini",
  "stocks": [
    {
      "symbol": "TSM",
      "name": "Taiwan Semiconductor",
      "reason": "Polymarket gives 11% that China will invade Taiwan by December 31, 2027, which matters for TSM because…",
      "marketId": "1633611",
      "weightPct": 32.75
    }
  ],
  "weights": {
    "status": "adjusted",
    "explanation": "Tilted by Polymarket odds moves over the past week: …",
    "holdings": [{ "symbol": "TSM", "weightPct": 32.75 }],
    "evidence": [
      {
        "title": "Will AI-chip export licensing become law this year?",
        "url": "https://polymarket.com/event/which-bills-will-become-law-in-2026",
        "outcome": "Yes",
        "probability": 0.225,
        "observedAt": "2026-10-10T00:35:01.000Z",
        "change7d": -0.125,
        "symbols": ["INTC", "NVDA"]
      }
    ]
  },
  "markets": [
    {
      "id": "1633611",
      "title": "Will China invade Taiwan by December 31, 2027?",
      "url": "https://polymarket.com/event/will-china-invade-taiwan-by-december-31-2027",
      "outcome": "Yes",
      "probability": 0.105,
      "observedAt": "2026-10-10T00:34:53.768Z",
      "change7d": null,
      "citedBy": ["stocks"]
    }
  ]
}
```

| Field       | Type                               | Meaning                                                                                                                                                                                                                                                                         |
| ----------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`        | string                             | 8 characters, lowercase letters and digits without look-alikes                                                                                                                                                                                                                  |
| `url`       | string                             | Link to share                                                                                                                                                                                                                                                                   |
| `createdAt` | string                             | ISO time                                                                                                                                                                                                                                                                        |
| `source`    | `"gemini"` \| `"fallback"` \| null | From `/api/stocks`; `null` when the client did not send it                                                                                                                                                                                                                      |
| `stocks[]`  | array                              | Each stock with its final `weightPct`; `marketId` is `null` when the reason cites no market                                                                                                                                                                                     |
| `weights`   | object                             | The saved weights step: `status` (`adjusted`, `unchanged`, `unavailable`), `explanation`, `holdings`, `evidence`                                                                                                                                                                |
| `markets[]` | array                              | Every market cited by either step, once, with the odds **at creation**. `id` is the Polymarket market id (`null` if it could not be identified). `citedBy` lists `"stocks"` and/or `"weights"`. When both steps cite a market, the odds shown are the ones from the stocks step |

The `201` response also has a `Location: /api/baskets/{id}` header. `GET` responses are cacheable for 60
seconds.

### Errors

| Status | `error.code`      | When                                                                                                                                                   |
| ------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 400    | `invalid_request` | Not JSON, a missing or invalid field (the message names it, e.g. `stocks.stocks: …`), holdings that do not match the stocks, weights not totalling 100 |
| 404    | `not_found`       | No basket with this id                                                                                                                                 |
| 413    | `too_large`       | Body over 64 KB                                                                                                                                        |
| 429    | `rate_limited`    | More than 20 saves per minute or 300 per day from one IP                                                                                               |
| 503    | `storage_error`   | The database is unreachable                                                                                                                            |

### From the frontend: `/js/baskets-adapter.js` (not wired in)

```js
import { saveBasket, getBasket, basketFromState } from "./baskets-adapter.js";

// After the weights step, from the controller's snapshot:
const basket = await saveBasket(basketFromState(controller.getState()));
showShareLink(basket.url); // https://prophetf.vercel.app/b/7fkbjd9w

// Or with the raw API responses: saveBasket({ idea, stocks: stocksResponse, weights: weightsResponse })

// Opening a shared basket:
const saved = await getBasket("7fkbjd9w");
```

`basketFromState` maps `controller.getState()` (status `ready`) to the request. Because the controller
drops `marketId`, `source` and `markets`, a basket saved this way keeps only the markets cited in the
weights evidence. To keep the stocks-step markets too, pass the raw `/api/stocks` response. Both functions
take `{ signal }` as a second argument and reject on any non-2xx status. For another backend URL:
`createBaskets({ baseUrl: "http://localhost:3000" })`.

### Try it

```powershell
$api = "https://prophetf.vercel.app"; $idea = "AI chips and Taiwan risk"
$stocks = Invoke-RestMethod -Method Post -Uri "$api/api/stocks" -ContentType "application/json" -Body (@{ idea = $idea } | ConvertTo-Json)
$n = $stocks.stocks.Count; $base = [math]::Floor(10000 / $n)
$holdings = for ($i = 0; $i -lt $n; $i++) { @{ symbol = $stocks.stocks[$i].symbol; weightPct = $(if ($i -eq $n - 1) { (10000 - $base * $i) / 100 } else { $base / 100 }) } }
$weights = Invoke-RestMethod -Method Post -Uri "$api/api/weights" -ContentType "application/json" -Body (@{ idea = $idea; holdings = @($holdings) } | ConvertTo-Json -Depth 4)
$body = [Text.Encoding]::UTF8.GetBytes((@{ idea = $idea; stocks = $stocks; weights = $weights } | ConvertTo-Json -Depth 8))
$basket = Invoke-RestMethod -Method Post -Uri "$api/api/baskets" -ContentType "application/json; charset=utf-8" -Body $body
$basket.url; Invoke-RestMethod -Uri "$api/api/baskets/$($basket.id)" | ConvertTo-Json -Depth 6
```

---

## 4. Odds history — LIVE

Every Polymarket probability the backend sees is stored in Tiger (TimescaleDB): the candidates of each
`/api/stocks` call, the signals behind `/api/weights`, the odds saved with a basket, a tick every minute
for markets cited by saved baskets, and 30 days of history loaded from Polymarket the first time a market
is seen.

| Endpoint                               | Purpose                                                           |
| -------------------------------------- | ----------------------------------------------------------------- |
| `GET /api/markets/{id}/history?range=` | Odds history of one market                                        |
| `GET /api/baskets/{id}/odds?range=`    | History of every market a basket cites, in one call (for a chart) |

`range` is `1d`, `7d` (default) or `30d`:

| `range` | Point spacing (`bucketSeconds`) | Points per market |
| ------- | ------------------------------- | ----------------- |
| `1d`    | 600 (10 minutes)                | up to 144         |
| `7d`    | 3600 (1 hour)                   | up to 168         |
| `30d`   | 10800 (3 hours)                 | up to 241         |

Points are evenly spaced and share the same time axis across markets; a bucket without a new tick repeats
the last known odds. A market younger than the range simply has fewer points. Odds are probabilities of
"Yes", from 0 to 1.

### `GET /api/markets/{id}/history?range=7d`

`{id}` is a Polymarket market id, e.g. a `marketId` from `/api/stocks` or a `markets[].id` of a basket.

```json
{
  "market": {
    "id": "1426260",
    "question": "Will AI-chip export licensing become law this year?",
    "url": "https://polymarket.com/event/which-bills-will-become-law-in-2026",
    "endDate": "2027-01-01T04:59:00.000Z",
    "closed": false
  },
  "range": "7d",
  "bucketSeconds": 3600,
  "from": "2026-10-03T01:35:00.000Z",
  "to": "2026-10-10T01:35:00.000Z",
  "current": 0.21,
  "change": -0.205,
  "points": [
    { "t": "2026-10-03T02:00:00.000Z", "p": 0.415 },
    { "t": "2026-10-03T03:00:00.000Z", "p": 0.415 }
  ],
  "queryMs": 6.8
}
```

| Field               | Meaning                                                                              |
| ------------------- | ------------------------------------------------------------------------------------ |
| `current`           | The last point's odds (`null` when there are no points)                              |
| `change`            | Last point minus first point of the range                                            |
| `points[].t` / `.p` | ISO time of the bucket start / probability                                           |
| `queryMs`           | Time the Tiger query took                                                            |
| `market.closed`     | `true` once the market has resolved; its last point is then the payout (1, 0 or 0.5) |

The first request for a market we have never seen loads its history first and can take 1 to 2 seconds.

### `GET /api/baskets/{id}/odds?range=30d`

```json
{
  "id": "dfxt3jwb",
  "createdAt": "2026-10-10T01:27:12.000Z",
  "range": "30d",
  "bucketSeconds": 10800,
  "from": "2026-09-10T01:35:00.000Z",
  "to": "2026-10-10T01:35:00.000Z",
  "markets": [
    {
      "id": "1633611",
      "title": "Will China invade Taiwan by December 31, 2027?",
      "url": "https://polymarket.com/event/will-china-invade-taiwan-by-december-31-2027",
      "citedBy": ["stocks", "weights"],
      "probabilityAtCreation": 0.105,
      "current": 0.105,
      "changeSinceCreation": 0,
      "closed": false,
      "points": [{ "t": "2026-09-10T03:00:00.000Z", "p": 0.11 }]
    }
  ],
  "untracked": [],
  "queryMs": 62.4
}
```

`markets` follows the order of the basket's `markets`. `changeSinceCreation` is `current` minus
`probabilityAtCreation`. `untracked` lists titles of cited markets whose Polymarket id is unknown (they
have no history). To mark the creation moment on a chart, use `createdAt`.

### Errors (both endpoints)

| Status | `error.code`      | When                                          |
| ------ | ----------------- | --------------------------------------------- |
| 400    | `invalid_request` | `range` is not `1d`, `7d` or `30d`            |
| 404    | `not_found`       | Unknown market or basket id                   |
| 429    | `rate_limited`    | More than 120 requests per minute from one IP |
| 503    | `storage_error`   | The database is unreachable                   |

### From the frontend

`/js/baskets-adapter.js` also exports `getBasketOdds(id, range)` and `getMarketHistory(marketId, range)`:

```js
import { getBasketOdds } from "./baskets-adapter.js";
const { markets } = await getBasketOdds(basket.id, "30d");
// one line per market: markets[i].points.map(({ t, p }) => [new Date(t), p * 100])
```

### Try it

```powershell
Invoke-RestMethod "https://prophetf.vercel.app/api/markets/1633611/history?range=7d" | ConvertTo-Json -Depth 4
Invoke-RestMethod "https://prophetf.vercel.app/api/baskets/dfxt3jwb/odds?range=30d" | ConvertTo-Json -Depth 5
```

---

## 5. `GET /api/built-with` — LIVE (Tiger and Gemini; other sponsors arrive with step 4)

Live proof per sponsor, as JSON for the frontend to render. No parameters.

```json
{
  "generatedAt": "2026-10-10T01:36:00.000Z",
  "tiger": {
    "enabled": true,
    "configured": true,
    "mode": "live",
    "service": "Tiger Cloud (PostgreSQL + TimescaleDB)",
    "postgres": "18.6",
    "timescaledb": "2.30.2",
    "rows": { "odds_ticks": 10023, "markets": 37, "baskets": 3, "odds_1h_buckets": 8551 },
    "ticksBySource": { "backfill": 9957, "stocks": 30, "tick": 25, "weights": 11 },
    "trackedMarkets": 12,
    "firstTickAt": "2026-09-10T02:00:00.000Z",
    "lastTickAt": "2026-10-10T01:35:00.000Z",
    "hypertable": { "name": "odds_ticks", "chunks": 5, "columnstoreChunks": 4, "size": "888 kB" },
    "continuousAggregate": { "name": "odds_1h", "bucket": "1 hour", "realTime": true },
    "jobs": [
      {
        "job": "policy_compression",
        "every": "12:00:00",
        "lastStatus": "Success",
        "lastSuccess": "2026-10-10T01:29:55.482Z"
      },
      {
        "job": "policy_refresh_continuous_aggregate",
        "every": "00:15:00",
        "lastStatus": "Success",
        "lastSuccess": "2026-10-10T01:29:55.481Z"
      }
    ],
    "queryLatencyMs": {
      "rowCounts": 8.3,
      "marketHistory1d_gapfill_over_ticks": 2.6,
      "marketHistory7d_gapfill_over_hourly_aggregate": 3.6,
      "basketOdds30d_gapfill_over_hourly_aggregate": 62.4,
      "basketOdds30d_markets": 6,
      "basketOdds30d_points": 1446
    }
  },
  "gemini": {
    "enabled": true,
    "configured": true,
    "mode": "live",
    "model": "gemini-3.5-flash",
    "backupModel": "gemini-3.5-flash-lite",
    "usedFor": "…"
  },
  "elevenlabs": { "enabled": false, "configured": false, "mode": "mock" },
  "solana": { "enabled": false, "configured": false, "mode": "mock" },
  "snowflake": { "enabled": false, "configured": false, "mode": "mock" },
  "presage": { "enabled": false, "configured": false, "mode": "mock" }
}
```

`queryLatencyMs` values are measured on each request by running the same queries the chart endpoints use.
`lastTickAt` is the time of the latest tick-job reading; `trackedMarkets` is how many markets saved baskets
cite. The fields under `elevenlabs`, `solana`, `snowflake` and `presage` will grow in step 4.

---

## 6. `POST /api/jobs/tick` — LIVE (not for the frontend)

Refreshes the odds of every open market cited by a saved basket and stores one tick per market, stamped on
the minute. Also loads history for newly cited markets (up to 4 per run). Requires
`Authorization: Bearer <CRON_SECRET>`; `GET` works too. Running it twice in the same minute adds nothing.

```json
{ "ok": true, "markets": 12, "ticks": 12, "closed": 0, "backfilled": 2, "ms": 2345 }
```

`401` with `error.code` `unauthorized` without the right token. Locally: `pnpm jobs:loop` (ticks
`http://localhost:3000` every minute) or `pnpm jobs:loop https://prophetf.vercel.app`.

---

## 6b. `/api/jobs/warm` — LIVE (not for the frontend)

Keeps the four demo ideas answered from the cache: "AI chips and Taiwan risk", "Fed rate cuts and housing",
"Clean energy after the election", "Crypto regulation". For each it pre-computes `/api/stocks` and the
`/api/weights` request the frontend sends next (the same symbols, equally weighted). Requires
`Authorization: Bearer <CRON_SECRET>`.

| Call                               | Effect                                                                                   |
| ---------------------------------- | ---------------------------------------------------------------------------------------- |
| `POST /api/jobs/warm`              | Refreshes the demo idea that is missing or expires first (one idea, two Gemini requests) |
| `POST /api/jobs/warm?idea=0` … `3` | Refreshes that idea                                                                      |
| `GET /api/jobs/warm`               | Cache status only                                                                        |

```json
{
  "ok": true,
  "idea": "Crypto regulation",
  "result": "refreshed",
  "source": "gemini",
  "symbols": ["COIN", "HOOD", "IBIT"],
  "weights": "adjusted",
  "expiresAt": "2026-10-10T02:53:44.000Z",
  "ms": 5800,
  "ideas": [
    { "idea": "AI chips and Taiwan risk", "cached": true, "expiresAt": "…", "secondsLeft": 843 }
  ]
}
```

`result` is `refreshed` (new AI answer cached), `kept` (Gemini was unavailable, so the previous AI answer's
expiry was extended instead of replacing it with a keyword fallback) or `failed` (nothing cached).

From `/web`: `pnpm demo:warm` (all four once), `pnpm demo:warm --loop` (all four, then one refresh every
3 minutes), `pnpm demo:warm --status`.

---

## 7. `GET /api/health` — LIVE

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

## 8. The Python service in `/backend` (reference, not deployed)

The weighting method is owned by the Polymarket teammate and lives in `/backend` (FastAPI, local port 8001;
see `/backend/README.md`). It is not deployed publicly; `POST /api/weights` above is its TypeScript port.
Its other endpoints (`/api/signals`, `/api/basket`, `/api/backtest`, …) exist only in the Python service.

Both services read the same 40 tickers and 11 signals from
`/backend/src/polyslice_api/data/universe.json`. After that file changes, run `pnpm sync:universe` in `/web`
and redeploy.
