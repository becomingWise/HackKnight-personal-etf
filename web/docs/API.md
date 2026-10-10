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

Implements the "Stock selection port" in `/docs/team-contracts.md`: an idea in, 3 to 5 stocks out. Since
2026-10-10 the answer comes from a fixed four-stage workflow (code in `web/src/lib/pipeline/`):

| Stage      | Owner            | What it does                                                                                                                                            |
| ---------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a. analyst | backend teammate | Collects Polymarket markets for the idea and analyzes them into an **evidence packet** (section 1b). Today a mock analyst answers.                      |
| b. gate    | code             | Enough relevant, fresh, liquid markets? If not, the request ends here with `422 not_enough_evidence` and Gemini is not called.                          |
| c. decider | Lucas            | Gemini (`gemini-3.5-flash`, structured JSON) picks 3 to 5 of the 40 allowed tickers and writes each reason, citing market ids from the packet.          |
| d. checker | code             | Verifies the answer against the packet. On errors the decider gets them back for **one** revision. An optional LLM review is off (`CHECKER_LLM=false`). |

The request and the response are unchanged; the response has one new optional field, `trace`.

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
  "summary": "This portfolio targets leading semiconductor companies exposed to the AI chip supply chain and geopolitical risk around Taiwan. Key Polymarket odds: \"Will AI-chip export licensing become law this year?\" 22%; \"Will China invade Taiwan by December 31, 2027?\" 11%.",
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
      "reason": "Polymarket gives 22% that AI-chip export licensing will become law this year, which matters for NVDA because it is the leading designer of AI processors subject to trade restrictions.",
      "marketId": "1426260"
    },
    {
      "symbol": "ASML",
      "name": "ASML Holding",
      "reason": "Polymarket sits at 22% for AI-chip export licensing becoming law this year and 11% for China invading Taiwan by December 31, 2027, both of which affect ASML's equipment shipments to Asian foundries.",
      "marketId": "1426260"
    }
  ],
  "source": "gemini",
  "markets": [
    {
      "id": "1426260",
      "title": "Will AI-chip export licensing become law this year?",
      "url": "https://polymarket.com/event/which-bills-will-become-law-in-2026",
      "outcome": "Yes",
      "probability": 0.22,
      "observedAt": "2026-10-10T13:53:58.999Z"
    },
    {
      "id": "1633611",
      "title": "Will China invade Taiwan by December 31, 2027?",
      "url": "https://polymarket.com/event/will-china-invade-taiwan-by-december-31-2027",
      "outcome": "Yes",
      "probability": 0.105,
      "observedAt": "2026-10-10T13:53:58.999Z"
    }
  ],
  "trace": [
    {
      "step": "analyst",
      "status": "ok",
      "ms": 387,
      "summary": "15 markets, 2 themes, 39 ticker signals (mock)"
    },
    { "step": "gate", "status": "ok", "ms": 0, "summary": "passed: 15 of 15 markets usable" },
    { "step": "decider", "status": "ok", "ms": 6618, "summary": "4 stocks (1 Gemini call)" },
    { "step": "checker", "status": "ok", "ms": 0, "summary": "passed, no revision" }
  ],
  "cached": false,
  "cachedAt": null
}
```

**Contract fields** (what `validateStocks` in `/js/controller.js` reads):

| Field             | Type   | Guarantee                                                                                                                           |
| ----------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `summary`         | string | Non-empty. How the idea maps to the companies, ending with the key Polymarket odds of the cited markets. Same language as the idea. |
| `stocks`          | array  | 3 to 5 items, unique symbols                                                                                                        |
| `stocks[].symbol` | string | One of the 40 tickers in the weighting backend's `universe.json`, so `POST /api/weights` can tilt every pick                        |
| `stocks[].name`   | string | Company name from `universe.json`                                                                                                   |
| `stocks[].reason` | string | Non-empty. Cites at least one Polymarket market from the evidence packet and quotes its current odds                                |

No allocation percentages, weights or stock prices are ever returned, per the contract.

**Extra fields** (optional to use; the controller ignores them):

| Field                | Type                       | Meaning                                                                                                                                                                            |
| -------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `stocks[].marketId`  | string                     | The first Polymarket market the reason cites; matches a `markets[].id`. Always set now (the type still allows `null` for old cached clients)                                       |
| `source`             | `"gemini"` \| `"fallback"` | `"fallback"` = Gemini was unavailable or its answer was rejected twice, and the stocks come from the analyst's ticker signals. The summary says so too                             |
| `markets`            | array                      | The cited markets, in the same shape as the `evidence` items of `adjustWeights`: `id`, `title`, `url`, `outcome` (always `"Yes"`), `probability` (0 to 1), `observedAt` (ISO time) |
| `trace`              | array                      | **New.** One entry per workflow stage, in order. Safe to ignore; meant for a "how this was decided" view                                                                           |
| `cached`, `cachedAt` | boolean, string \| null    | Whether the answer came from the cache and when it was computed                                                                                                                    |

**`trace` entries:** `{ "step", "status", "ms", "summary" }`.

| Field     | Values                                                                                                                                                                                                             |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `step`    | `"analyst"`, `"gate"`, `"decider"`, `"checker"` (from `/api/decide` the trace starts at `"gate"`)                                                                                                                  |
| `status`  | `"ok"`; `"warn"` = worked with a caveat (a revision was needed, stocks were dropped, the backup analyst answered); `"failed"`; `"skipped"`                                                                         |
| `ms`      | Time the stage took                                                                                                                                                                                                |
| `summary` | One line for people, for example `"7 markets, 3 themes, 12 ticker signals (mock)"`, `"passed: 7 of 9 markets usable (2 not relevant, 0 illiquid, 0 ended)"`, `"4 stocks (2 Gemini calls)"`, `"passed, 1 revision"` |

A cached answer carries the trace of the run that produced it.

### Error responses

| Status | `error.code`          | When                                                                                                                                                                                                                          |
| ------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request`     | Body is not JSON, or `idea` is missing, not a string, empty, or longer than 500 characters                                                                                                                                    |
| 422    | `not_enough_evidence` | The gate found fewer than 2 usable markets. `error.message` says why in plain words and names 3 ideas that work; the same is in `error.reason` (the why alone) and `error.examples` (string array). The body also has `trace` |
| 429    | `rate_limited`        | Per-IP limit hit (30 per minute, 600 per day). `Retry-After` gives the seconds to wait. The Gemini budget never causes a 429                                                                                                  |
| 502    | `no_match`            | Gemini is unavailable and the packet links fewer than 3 supported tickers to its markets                                                                                                                                      |
| 502    | `upstream_error`      | Unexpected failure                                                                                                                                                                                                            |

```json
{
  "error": {
    "code": "not_enough_evidence",
    "message": "Polymarket has open markets near this idea, but they do not connect it to the stocks we cover (chips, AI and big tech, energy, defense, banks, crypto, interest rates). Ideas that work: \"AI chips and Taiwan risk\", \"Fed rate cuts and housing\", \"Crypto regulation\".",
    "reason": "Polymarket has open markets near this idea, but they do not connect it to the stocks we cover (chips, AI and big tech, energy, defense, banks, crypto, interest rates).",
    "examples": ["AI chips and Taiwan risk", "Fed rate cuts and housing", "Crypto regulation"]
  },
  "trace": [
    {
      "step": "analyst",
      "status": "ok",
      "ms": 412,
      "summary": "1 markets, 0 themes, 0 ticker signals (mock)"
    },
    {
      "step": "gate",
      "status": "failed",
      "ms": 0,
      "summary": "not enough evidence: 0 of 1 markets usable (1 not relevant, 0 illiquid, 0 ended), need 2"
    },
    { "step": "decider", "status": "skipped", "ms": 0, "summary": "not called: the gate failed" }
  ]
}
```

The adapter must reject on any non-2xx status; the controller then shows its own retry message.
`/js/stocks-adapter.js` already throws `error.message`, so the 422 text reaches the user unchanged.

### Behaviour

- **Gate rules** (`web/src/lib/pipeline/gate.ts`). A market is usable when the analyst rates its
  `relevance` at 0.4 or more, its `liquidity` is known and at least $1,000, its end date is in the future and
  its odds are strictly between 0 and 1. The packet must be at most 60 minutes old. At least 2 usable markets
  are needed. The decider only ever sees the usable markets.
- **Checker rules** (`web/src/lib/pipeline/checker.ts`). Every ticker is one of the 40 and appears once;
  there are 3 to 5 stocks; every stock cites at least one market id and every cited id is in the packet; each
  reason quotes the odds of a market it cites; every percentage is within 1 point of the Yes or No odds of a
  cited market (or is part of that market's question); every odds move ("up 1.2 pts") is within 0.5 points of
  the cited market's 24-hour or 7-day change; the summary contains no percentages.
- **One revision, never two.** If the checker finds errors, the decider gets its own answer and the list of
  errors back once. If the second answer still fails, the stocks that pass on their own are kept when there
  are at least 3; otherwise the evidence-only fallback answers (`"source": "fallback"`): the analyst's first
  ticker signals, each with its market and odds.
- **Timing.** Typically 3 to 5 seconds for a new idea: the analyst 1 to 2 seconds (search plan and Polymarket
  searches), one Gemini call of about 2 seconds for the decision. Gemini has 20 seconds in total; after that
  the fallback answers in the same shape.
- **Caching.** Answers are cached in Tiger for 15 minutes, shared by all servers. Ideas that differ only in case, spacing or surrounding punctuation share an entry. The body says so: `"cached": true` with `"cachedAt"` (ISO time the answer was computed), or `"cached": false, "cachedAt": null`. The same is in the headers `X-Cache: HIT|MISS` and `X-Cache-Age` (seconds). Fallback answers and 422s are never cached. Cached answers return in about 0.1 s.
- **Models.** The decider runs on `gemini-3.5-flash-lite`. `DECIDER_MODEL=gemini-3.5-flash` switches it to the main model (then the lite model is its backup on 429/503). The lite model never spills over to the main one. The manager's note (section 4b) still uses `gemini-3.5-flash`.
- **Gemini calls per uncached request.** Normally **2** (search plan + decision), **3 at most** (plus one revision or one retry), all on the lite model; **1** when the search plan is cached (same idea within 24 hours); **0** for a cached answer and for an idea that stops at the gate with a cached plan. With `CHECKER_LLM=true` one more.
- **Gemini budget.** Every cap is derived from the account's limits in `web/src/lib/pipeline/budget.ts`, set with `GEMINI_LITE_RPM`, `GEMINI_LITE_RPD`, `GEMINI_FLASH_RPM`, `GEMINI_FLASH_RPD`. Visitors' requests may use 80% of a model's per-minute quota and 75% of its daily quota (the rest is for the warm job, manager's notes and evals), and one 30-minute window at most 40% of the day's requests. With the assumed limits of 15 per minute and 200 per day for the lite model: **4 uncached requests per minute, 20 per 30 minutes, 50 per day, and 10 per 30 minutes per IP** may use Gemini, which is at most 12 calls per minute, 60 per 30 minutes and 150 per day.
- **Over budget is not an error.** A request beyond a cap is answered without Gemini: the analyst searches by keyword and the stocks come from the evidence alone (`"source": "fallback"`, the `decider` trace entry says `skipped`). Such answers are not cached, so the idea gets an AI answer once the budget frees up. Cached answers are never affected.
- **Rate limits.** 30 requests per minute and 600 per day per IP, cached or not (`429`).
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

Locally without HTTP: `pnpm try:findstocks "your idea"` in `/web` (add `--packet` to stop after the gate,
which uses no Gemini call).

---

## 1b. The evidence packet and `POST /api/analyze` — LIVE

The **EvidencePacket** is the handoff from the analyst to the decider. The schema is
`web/src/lib/analyst/packet.ts` (zod, exported type `EvidencePacket`); `web/docs/HANDOFF.md` explains it for
the analyst's author with a full example and the two ways to plug a real analyst in.

```ts
type Signal = "bullish" | "bearish" | "neutral";

type EvidencePacket = {
  idea: string; // 1 to 500 characters
  generatedAt: string; // ISO date-time; the gate rejects packets older than 60 minutes
  markets: {
    // at most 40, most relevant first, unique ids
    id: string; // Polymarket's numeric market id
    question: string;
    url: string;
    probability: number; // current odds of "Yes", 0 to 1
    change24h: number | null; // change of probability, in probability units: 0.03 = +3 points
    change7d: number | null;
    volume24h: number | null; // US dollars
    liquidity: number | null; // US dollars; null does not pass the gate
    endDate: string | null; // ISO date-time
    relevance: number; // 0 to 1, how much the market matters for the idea; the gate needs 0.4
    signal: Signal; // what the market's level and move mean for the idea's stocks
    analystNote: string; // 0 to 400 characters, read by the decider
  }[];
  themes: { name: string; direction: Signal; confidence: number; marketIds: string[] }[]; // at most 12
  tickerSignals: {
    // at most 60, most important first
    symbol: string; // tickers outside the 40-stock universe are ignored
    impact: number; // -1 (strongly negative) to +1 (strongly positive)
    marketIds: string[]; // at least one; the market `why` is about goes first
    why: string; // 1 to 300 characters
  }[];
  warnings: string[]; // at most 20
};
```

Every id in `themes[].marketIds` and `tickerSignals[].marketIds` must be the `id` of a market in `markets`.

### `POST /api/analyze`

Runs only the analyst (and reports what the gate would say). The mock analyst makes one Gemini call on the
lighter model for a new idea (its search plan, cached for a day); nothing else calls Gemini. When the gate
would fail, `gate.reason` has the plain-words explanation. Use it to see what the decider
is given for an idea, or to check a new analyst.

Request: `{ "idea": string }`, as for `/api/stocks`.

Response — `200`:

```json
{
  "packet": {
    "idea": "AI chips and Taiwan risk",
    "generatedAt": "2026-10-10T13:54:16.488Z",
    "markets": [
      {
        "id": "1426260",
        "question": "Will AI-chip export licensing become law this year?",
        "url": "https://polymarket.com/event/which-bills-will-become-law-in-2026",
        "probability": 0.22,
        "change24h": 0.035,
        "change7d": -0.095,
        "volume24h": 662.76,
        "liquidity": 12658.728,
        "endDate": "2027-01-01T04:59:00Z",
        "relevance": 0.75,
        "signal": "bullish",
        "analystNote": "Yes is at 22%, -9.5 pts over 7 days. The weighting universe links it to 5 tickers."
      }
    ],
    "themes": [
      {
        "name": "Semiconductors",
        "direction": "bullish",
        "confidence": 0.9,
        "marketIds": ["1426260"]
      }
    ],
    "tickerSignals": [
      {
        "symbol": "NVDA",
        "impact": 0.61,
        "marketIds": ["1426260"],
        "why": "NVIDIA loses if \"AI-chip export licensing becomes law\" gets more likely."
      }
    ],
    "warnings": ["Mock analyst: keyword search and fixed market-to-ticker links, no analysis."]
  },
  "gate": { "passed": true, "summary": "passed: 15 of 15 markets usable" },
  "trace": [
    {
      "step": "analyst",
      "status": "ok",
      "ms": 720,
      "summary": "15 markets, 2 themes, 39 ticker signals (mock)"
    },
    { "step": "gate", "status": "ok", "ms": 0, "summary": "passed: 15 of 15 markets usable" }
  ]
}
```

`packet` is the full packet, including markets the gate would not use. Errors: `400 invalid_request`,
`429 rate_limited` (30 per minute and 600 per day per IP), `502 upstream_error`.

**Which analyst answers** is set by the `ANALYST_MODE` env var (shown in `GET /api/health` under
`pipeline.analystMode`):

| `ANALYST_MODE`   | Analyst                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mock` (default) | Built in: one `gemini-3.5-flash-lite` call turns the idea into 3 to 6 search queries and the sectors it touches (cached 24 hours, 5 s limit, keywords instead when it fails or the budget is used up), then Polymarket search, the weighting universe's market → ticker links, 24-hour and 7-day changes from the odds history in Tiger (Polymarket's own change fields where Tiger has no history yet) |
| `module`         | `analyze(idea)` exported by `web/src/lib/analyst/index.ts` (HANDOFF option A)                                                                                                                                                                                                                                                                                                                           |
| `tiger`          | Reads the tables `analyst_packets` and `market_analysis` (HANDOFF option B)                                                                                                                                                                                                                                                                                                                             |

If the `module` or `tiger` analyst throws or returns an invalid packet, the mock answers instead; the
`analyst` trace entry then has `"status": "warn"` and the packet's first warning says why.

PowerShell:

```powershell
$a = Invoke-RestMethod -Method Post -Uri "https://prophetf.vercel.app/api/analyze" -ContentType "application/json" -Body '{"idea":"AI chips and Taiwan risk"}'
$a.trace | Format-Table step, status, ms, summary
```

---

## 1c. `POST /api/decide` — LIVE

Runs the gate, the decider and the checker on a packet you send. Use it to test the decider against a
hand-written or saved packet, or to check that a new analyst's packets lead to good answers.

Request (at most 64 KB):

```json
{ "idea": "AI chips and Taiwan risk", "packet": { "...": "an EvidencePacket, see section 1b" } }
```

Response: exactly the `/api/stocks` response (`200` with `trace` starting at `"gate"`), and the same errors.
A packet that breaks the schema gets `400 invalid_request` with the field in the message, for example
`"packet.themes.0.direction: Invalid option: expected one of \"bullish\"|\"bearish\"|\"neutral\""`. A packet
whose `generatedAt` is more than 60 minutes old gets `422 not_enough_evidence`.

Answers are cached for 15 minutes per idea and exact packet. Uncached requests count against the same
Gemini budget as `/api/stocks` (section 1, Behaviour).

PowerShell (analyze, then decide on that packet):

```powershell
$a = Invoke-RestMethod -Method Post -Uri "https://prophetf.vercel.app/api/analyze" -ContentType "application/json" -Body '{"idea":"AI chips and Taiwan risk"}'
$body = @{ idea = "AI chips and Taiwan risk"; packet = $a.packet } | ConvertTo-Json -Depth 8
Invoke-RestMethod -Method Post -Uri "https://prophetf.vercel.app/api/decide" -ContentType "application/json; charset=utf-8" -Body $body | ConvertTo-Json -Depth 5
```

**Eval.** `pnpm eval:decider` in `/web` runs the decider on 10 fixed ideas with fixed mock packets
(`web/src/lib/pipeline/evalCases.ts`) and prints, per case and in total: whether the first answer passed
every checker rule, whether the final answer did, whether every number in it is grounded in the cited
markets, the Gemini calls, the latency, and how many reasons paste a market question word for word. It runs on
`gemini-3.5-flash-lite`, the decider's default model (about 1 minute, 9 calls); `--main` runs it on
`gemini-3.5-flash`, whose daily quota is small, so ask Lucas first. Run it before
and after every change to the prompt in `web/src/lib/pipeline/decider.ts`.

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

| Port                                              | Module                   | Calls                                                                                                                                                                                                                            |
| ------------------------------------------------- | ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `findStocks`                                      | `/js/stocks-adapter.js`  | `POST /api/stocks`                                                                                                                                                                                                               |
| `adjustWeights`                                   | `/js/weights-adapter.js` | `POST /api/weights`                                                                                                                                                                                                              |
| save / open a basket, odds charts, manager's note | `/js/baskets-adapter.js` | `POST /api/baskets`, `GET /api/baskets/{id}` (section 3), `GET /api/baskets/{id}/odds`, `GET /api/markets/{id}/history` (section 4), `POST /api/baskets/{id}/letter` (section 4b), `POST /api/baskets/{id}/narrate` (section 4c) |

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

## 4b. Manager's note — LIVE

`POST /api/baskets/{id}/letter`

A short letter (at most 120 words) explaining a saved basket: what it bets on, which holdings carry the
most weight and why, and which Polymarket markets back it. Written by Gemini from the basket's own data.
No request body.

```json
{
  "id": "dfxt3jwb",
  "letter": "This basket bets on the expansion of AI hardware and semiconductor technology while tracking geopolitical risks in Taiwan. NVDA carries the highest weight at 27.49%, followed closely by AMD at 26.58%… These market odds reflect event probabilities rather than financial returns.",
  "words": 108,
  "source": "gemini",
  "generatedAt": "2026-10-10T03:05:12.000Z",
  "cached": false,
  "cachedAt": null
}
```

| Field                | Meaning                                                                                                                      |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `letter`             | Plain text, one or two paragraphs, in the language of the idea. Show it as text, not HTML                                    |
| `words`              | Word count of the letter                                                                                                     |
| `source`             | `"gemini"`, or `"fallback"` when Gemini failed or timed out and a template built from the basket's data was returned instead |
| `generatedAt`        | When the letter was written                                                                                                  |
| `cached`, `cachedAt` | Same meaning as on `/api/stocks`; also in the `X-Cache` and `X-Cache-Age` headers                                            |

- A basket never changes, so its letter is written once and then served from the cache (kept 30 days).
  The first call usually takes 1 to 3 seconds (up to about 10 if a retry is needed), later calls about 0.1 seconds. Calling it again is safe.
- Every percentage in the letter is checked against the basket's weights and the odds saved with it; a
  letter with any other percentage, or over 120 words, is rejected and rewritten once, then the template is
  used. Fallback letters are not cached.
- It uses the same models as `/api/stocks` (main model first, backup on quota errors), so a new letter
  counts as one more Gemini request against the per-minute quota.

| Status | `error.code`    | When                                                                               |
| ------ | --------------- | ---------------------------------------------------------------------------------- |
| 404    | `not_found`     | No basket with this id                                                             |
| 429    | `rate_limited`  | More than 20 requests per minute from one IP, or 400 new letters in a day in total |
| 503    | `storage_error` | The database is unreachable                                                        |

From the frontend: `getBasketLetter(id)` in `/js/baskets-adapter.js`.

```powershell
Invoke-RestMethod -Method Post -Uri "https://prophetf.vercel.app/api/baskets/dfxt3jwb/letter" | ConvertTo-Json
```

---

## 4c. Audio briefing — LIVE (ElevenLabs)

| Endpoint                         | Purpose                                                         |
| -------------------------------- | --------------------------------------------------------------- |
| `POST /api/baskets/{id}/narrate` | Creates (once) and returns the audio briefing of a saved basket |
| `GET /api/audio/{id}`            | The MP3 itself; `{id}` is the basket id                         |

The script is the basket's manager's note (section 4b) with a one-line intro, adapted for speech: company
names instead of tickers, weights rounded to whole percentages. ElevenLabs reads it; the MP3 is stored in
Tiger. No request body.

### `POST /api/baskets/{id}/narrate`

```json
{
  "id": "dfxt3jwb",
  "mode": "live",
  "script": "Here is the ProphETF briefing for your idea: AI chips and Taiwan risk. This portfolio is betting on artificial intelligence hardware and the geopolitical risks surrounding Taiwan. NVIDIA carries the heaviest weight at 27%…",
  "words": 128,
  "audioUrl": "https://prophetf.vercel.app/api/audio/dfxt3jwb",
  "mime": "audio/mpeg",
  "bytes": 1040762,
  "durationSeconds": 65,
  "model": "eleven_flash_v2_5",
  "generatedAt": "2026-10-10T03:19:40.561Z",
  "cached": false
}
```

| Field             | Meaning                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `mode`            | `"live"`: `audioUrl` is a playable MP3. `"mock"`: no audio (see below); `audioUrl`, `mime`, `bytes`, `durationSeconds`, `model` and `generatedAt` are `null` |
| `script`          | The text that is (or would be) read aloud. Always present                                                                                                    |
| `audioUrl`        | Put it in `<audio src>`; byte ranges are supported, so seeking and Safari work                                                                               |
| `durationSeconds` | Length of the MP3 (128 kbit/s), typically about a minute                                                                                                     |
| `cached`          | `true` when the stored briefing was returned                                                                                                                 |
| `note`            | Only in `mock` mode: why there is no audio                                                                                                                   |

- **Always answers 200 for an existing basket.** If ElevenLabs is switched off, fails, or the daily budget
  of 30 new briefings is used up, the response is `mode: "mock"` with the script and a `note`, so the page
  can show the text or read it with the browser's `speechSynthesis`. Nothing is stored in that case, and a
  later call tries again.
- A basket never changes, so its briefing is created once (2 to 4 seconds if the manager's note already
  exists, a few more otherwise) and then returned in about 0.1 seconds. Calling it again is safe.

| Status | `error.code`    | When                                         |
| ------ | --------------- | -------------------------------------------- |
| 404    | `not_found`     | No basket with this id                       |
| 429    | `rate_limited`  | More than 10 requests per minute from one IP |
| 503    | `storage_error` | The database is unreachable                  |

### `GET /api/audio/{id}`

`200` with `Content-Type: audio/mpeg`, or `206` for a `Range` request. `404` (JSON error) when the basket has
no stored briefing. Cacheable for a day; readable from any origin.

### From the frontend

```js
import { getBasketNarration } from "./baskets-adapter.js";
const briefing = await getBasketNarration(basket.id);
if (briefing.audioUrl) audioElement.src = briefing.audioUrl;
else showText(briefing.script); // mode "mock"
```

```powershell
$b = Invoke-RestMethod -Method Post -Uri "https://prophetf.vercel.app/api/baskets/dfxt3jwb/narrate"
$b.mode; $b.durationSeconds; Start-Process $b.audioUrl
```

---

## 5. `GET /api/built-with` — LIVE (Tiger, Gemini, ElevenLabs; Solana and Presage arrive with step 4)

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
    "usedFor": ["POST /api/stocks: …", "POST /api/baskets/{id}/letter: …"],
    "cachedStockAnswers": 4,
    "lastStockAnswerAt": "2026-10-10T02:38:44.028Z",
    "lettersWritten": 2,
    "lastLetterAt": "2026-10-10T03:05:12.000Z",
    "demoIdeasCached": 4,
    "demoIdeas": 4
  },
  "elevenlabs": {
    "enabled": true,
    "configured": true,
    "mode": "live",
    "model": "eleven_flash_v2_5",
    "usedFor": "POST /api/baskets/{id}/narrate: …",
    "briefings": 1,
    "audioSeconds": 65,
    "audioStoredIn": "Tiger (bytea), served from /api/audio/{id}",
    "charactersBilled": 85,
    "lastBriefingAt": "2026-10-10T03:19:40.561Z",
    "latestAudioUrl": "https://prophetf.vercel.app/api/audio/dfxt3jwb"
  },
  "solana": { "enabled": false, "configured": false, "mode": "mock" },
  "presage": { "enabled": false, "configured": false, "mode": "mock" }
}
```

`queryLatencyMs` values are measured on each request by running the same queries the chart endpoints use.
`lastTickAt` is the time of the latest tick-job reading; `trackedMarkets` is how many markets saved baskets
cite. Under `gemini`, `cachedStockAnswers` and `lettersWritten` count live cache entries and `demoIdeasCached` shows how many of the demo ideas are currently warm. Under `elevenlabs`, `briefings` and `audioSeconds` count the MP3s stored in Tiger and `latestAudioUrl` is a playable example. The fields under `solana` and `presage` will grow in step 4. Only sponsors the project actually uses are listed.

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
    "gemini": { "enabled": true, "configured": true, "mode": "live" }
  }
}
```

`sponsors` has one entry each for `tiger`, `gemini`, `elevenlabs`, `solana`, `presage`, `ws`. The response
also carries `"pipeline": { "analystMode": "mock", "checkerLlm": false }`: which analyst writes the evidence
packet for `/api/stocks` (section 1b) and whether the checker's LLM review is on.

---

## 8. The Python service in `/backend` (reference, not deployed)

The weighting method is owned by the Polymarket teammate and lives in `/backend` (FastAPI, local port 8001;
see `/backend/README.md`). It is not deployed publicly; `POST /api/weights` above is its TypeScript port.
Its other endpoints (`/api/signals`, `/api/basket`, `/api/backtest`, …) exist only in the Python service.

Both services read the same 40 tickers and 11 signals from
`/backend/src/polyslice_api/data/universe.json`. After that file changes, run `pnpm sync:universe` in `/web`
and redeploy.
