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

Since 2026-10-10 this is answered by **one Gemini agent** with retrieval, tools and session memory. The
code lives at the repository root in `/agent` (`agent/gemini.js` exports `findStocks`); this backend runs
a copy of those files (`pnpm sync:agent`, `web/src/lib/agent-core`), so the local server
(`node backend/server.js`) and production are one implementation. Team contract: `TEAM_HANDOFF.md`.

### Request

```json
{ "idea": "AI chips and Taiwan risk" }
```

| Field    | Type    | Rules                                                                            |
| -------- | ------- | -------------------------------------------------------------------------------- |
| `idea`   | string  | Required, 1 to 500 characters, any language                                      |
| `basket` | boolean | Optional. `true` adds a display `basket` with equal starting weights (see below) |

Optional header **`X-Session-Id`** (1 to 64 letters, digits, `_ . : -`): the agent remembers stated
preferences ("no oil companies") and earlier baskets per session. `/js/stock-api.js` sends one id per
browser tab. Without the header nothing is remembered.

### Success response — `200`

```json
{
  "summary": "Your AI chips and Taiwan risk basket",
  "stocks": [
    { "symbol": "NVDA", "name": "NVIDIA" },
    { "symbol": "TSM", "name": "Taiwan Semiconductor" },
    { "symbol": "ASML", "name": "ASML Holding" }
  ]
}
```

- **Exactly these two fields.** No `reason`, `research`, `trace`, `markets`, `source` or `cached`.
- `stocks`: exactly 3, unique symbols, always from the 40 tickers the weighting service can tilt
  (`agent/project-notes.json`, taken from `backend/src/polyslice_api/data/universe.json`). Names are the
  list's own, not written by the model.
- `summary`: at most 12 words from Gemini. When the pick rests on live Polymarket markets, the server
  appends one sentence with their odds (at most 2 markets), for example
  `"Your AI chips and Taiwan risk basket Live Polymarket odds: China invades Taiwan 8% (▼2 pts this week)."`
  That sentence is built by the server from the live figures when the answer is served (also for a
  cached answer), never written by Gemini. No market, or Polymarket unreachable: no sentence.
- With `"basket": true` the response also has
  `"basket": { "title", "allocationMethod": "equal", "holdings": [{ "symbol", "name", "weightPct" }] }`
  (33.33 / 33.33 / 33.34, from the controller's `startingWeights`).

### Error responses

| Status | `error.code`                                                         | When                                                      |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------- |
| 400    | `invalid_request`, `invalid_idea`                                    | Body is not JSON; `idea` missing, empty or over 500 chars |
| 429    | `rate_limited`                                                       | More than 30 requests a minute or 600 a day from one IP   |
| 502    | `invalid_selection`, `call_limit`, `gemini_failed`, `upstream_error` | Gemini did not produce a valid basket                     |
| 503    | `gemini_unavailable`                                                 | Every model is rate limited or over its daily budget      |
| 504    | `timeout`                                                            | No answer within 25 seconds                               |

A failure is always an error: the service never substitutes demo or fallback companies.

### Behaviour

- **Gemini calls per request:** 2 normally (the model calls `check_selection`, then answers), 4 at most,
  0 for a reused answer.
- **Gemini thinks again only when the odds move.** An answer that rests on live Polymarket markets is
  stored with their odds and reused until one of them has moved **3 points or more** (compared with
  the live odds when serving), for up to 24 hours. An answer that rests on no market, or whose markets
  cannot be read right now, is reused for 15 minutes. Identical ideas are shared across visitors; only
  a session with saved preferences gets entries of its own (its preferences shape the answer).
- **Headers:** `X-Cache: HIT` (reused, no Gemini call) or `MISS` (new Gemini calls), and
  `X-Odds-Moved`: the largest move of the answer's markets since it was made, in points (`"2.5"`). On
  a `MISS` it is the move that made the old answer stale. Absent when the answer rests on no market.
  Every answer is counted for `GET /api/savings` (section 1e).
- **Models:** `gemini-3.5-flash-lite`, then `gemini-3.1-flash-lite`, counted against the per-model
  budgets shown in `GET /api/health`. A call that takes over 9 seconds moves on to the next model.
- **Tools:** `check_selection` (exactly 3, unique, allowed), `get_memory`, `remember_preference`, and
  `google_search` (a separate grounded Gemini call; when it has no quota the agent decides without it).
- **Live Polymarket context (no extra Gemini call):** the handler loads the same live signals as
  `/api/weights` (`liveSignals`, cached 60 s, waited for at most 3 s) and the agent's prompt gets one
  line per live signal: id, question, Yes odds, 7-day change and β per ticker. The stocks must fit the
  idea first; when the idea touches one of these events the agent prefers the fitting tickers with
  the largest |β| and names the signal ids it used in an internal field. The server drops unknown ids
  and ids with no β on a picked ticker; what is left feeds the odds sentence. If the signals fail or
  are missing, the request runs exactly as it did before (the local `backend/server.js` passes none).
- **Typical time:** 1.5 to 5 seconds; a repeat is instant.

### Try it

PowerShell:

```powershell
$r = Invoke-RestMethod -Method Post -Uri https://prophetf.vercel.app/api/stocks -ContentType "application/json" -Headers @{ "X-Session-Id" = "lucas-test" } -Body '{"idea":"AI chips and Taiwan risk"}'
$r.summary; $r.stocks | Format-Table symbol, name
```

From the website: `import { findStocks } from "./stock-api.js"` (it reads `API_BASE_URL` from
`js/config.js`).

> Sections 1b and 1c below are the earlier evidence workflow (analyst → gate → decider → checker). It is
> no longer behind `/api/stocks`; it stays available at `POST /api/analyze` and `POST /api/decide` only.

---

## 1d. AI voting panel — `POST /api/votes` — LIVE

Five AI voters look at the basket `/api/stocks` returned and each votes yes or no on every stock
(the "parallelization: voting" pattern of Anthropic's "Building effective agents"). Each voter is a
separate Gemini call with its own system prompt, all five run in parallel, and code counts the votes.
It does not change `findStocks` or its response; it only comments on a basket.

| Agent (`votes[].agent`) | Point of view                                                                    |
| ----------------------- | -------------------------------------------------------------------------------- |
| `Growth investor`       | Upside and demand                                                                |
| `Value / risk`          | Price, debt, concentration                                                       |
| `Macro & events`        | The live Polymarket odds and 7-day moves of `/api/weights` (its `evidence` list) |
| `Skeptic`               | Reasons the stock does NOT fit the idea                                          |
| `Fit checker`           | Does the company really match what the user asked?                               |

### Request

```json
{
  "idea": "AI chips and Taiwan risk",
  "stocks": [
    { "symbol": "NVDA", "name": "NVIDIA" },
    { "symbol": "TSM", "name": "Taiwan Semiconductor" },
    { "symbol": "AMD", "name": "Advanced Micro Devices" }
  ]
}
```

- `idea`: 1 to 500 characters, the idea the basket was built for.
- `stocks`: 1 to 5 stocks, exactly as `/api/stocks` returned them. Only the 40 tickers `/api/stocks`
  can return are accepted; the names shown to the voters come from the server's own list.

### Success response — `200`

```json
{
  "stocks": [
    {
      "symbol": "NVDA",
      "name": "NVIDIA",
      "yes": 4,
      "no": 1,
      "votes": [
        {
          "agent": "Growth investor",
          "vote": "yes",
          "reason": "AI chip demand keeps growing fast."
        },
        {
          "agent": "Value / risk",
          "vote": "no",
          "reason": "Rich price leaves little room for error."
        },
        {
          "agent": "Macro & events",
          "vote": "yes",
          "reason": "Taiwan invasion odds are low and steady."
        },
        { "agent": "Skeptic", "vote": "yes", "reason": "No serious reason it does not fit." },
        { "agent": "Fit checker", "vote": "yes", "reason": "Designs the leading AI chips." }
      ]
    }
  ],
  "summary": "2 of 3 stocks backed by a majority"
}
```

- `stocks`: in the order of the request. `votes` always has the five agents, in the order of the table.
- `vote`: `"yes"`, `"no"` or `"none"`. `"none"` means that agent gave **no answer** (its call failed or
  its answer was unusable); `reason` is then `"No answer."`. A vote is never invented, so
  `yes + no` can be less than 5. Show `"none"` as "no answer".
- `reason`: at most 15 words.
- `summary`: a stock is "backed by a majority" with 3 or more yes votes. When agents are missing it
  ends with e.g. `(1 of 5 agents gave no answer)`.
- Headers: `X-Cache: HIT | MISS` (and `X-Cache-Age` in seconds on a hit), and `X-Odds-Moved`: how many
  points the Polymarket odds the panel was given have moved since it voted (absent when no market is
  linked to the stocks).

### Error responses

| Status | `error.code`        | When                                                                              |
| ------ | ------------------- | --------------------------------------------------------------------------------- |
| 400    | `invalid_request`   | Body is not JSON; `idea` or `stocks` missing; duplicate or unknown symbols        |
| 429    | `rate_limited`      | More than 20 requests a minute or 300 a day from one IP                           |
| 503    | `ai_budget_used_up` | The shared caps for AI requests are used up; `Retry-After` says when to try again |
| 503    | `votes_unavailable` | None of the five voters answered                                                  |

### Behaviour

- **Gemini calls per request:** 5 (one per voter), 0 for a repeat. Flash-Lite only: three voters start
  on `gemini-3.5-flash-lite` and two on `gemini-3.1-flash-lite`, each with the other model as its only
  backup. Calls are counted against the per-model budgets in `GET /api/health`.
- **Cache:** per (idea, set of symbols); the order of the stocks does not matter. A panel is stored
  with the odds of the Polymarket markets linked to its stocks and reused until one of them has moved
  **3 points or more**, for up to 24 hours. With no linked market, or when the odds cannot be read, it
  is reused for 30 minutes. Only a complete panel is cached, so a voter that was briefly unavailable
  gets another chance. Every answer is counted for `GET /api/savings` (section 1e).
- **Caps:** an uncached panel counts as two requests against the shared caps of the evidence workflow
  (`ai:minute`, `ai:30min`, `ai:day`, per IP per 30 minutes).
- **Typical time:** 2 to 4 seconds; each voter has 9 seconds.

### Try it

PowerShell:

```powershell
$body = '{"idea":"AI chips and Taiwan risk","stocks":[{"symbol":"NVDA","name":"NVIDIA"},{"symbol":"TSM","name":"Taiwan Semiconductor"},{"symbol":"AMD","name":"Advanced Micro Devices"}]}'
$r = Invoke-RestMethod -Method Post -Uri https://prophetf.vercel.app/api/votes -ContentType "application/json" -Body $body
$r.summary; $r.stocks | ForEach-Object { "{0}: {1} yes, {2} no" -f $_.symbol, $_.yes, $_.no; $_.votes | Format-Table agent, vote, reason -Wrap }
```

From the website: `/js/votes-api.js` (same style as `stock-api.js`; reads `API_BASE_URL` from
`js/config.js`, rejects on any non-2xx status).

```js
import { getVotes } from "./votes-api.js";

const { stocks, summary } = await getVotes({ idea, stocks: selection.stocks }, { signal });
// per stock: `${s.yes} of ${s.votes.length} agents say yes`, a yes/no bar, and one line per vote.
```

Always show the caveat **"AI opinions, not financial advice."** next to the votes.

---

## 1e. `GET /api/savings` — LIVE

What reusing answers saved today. `/api/stocks` and `/api/votes` count every answer they serve: did it
need new Gemini calls, or was it reused because the odds behind it had not moved 3 points?

```json
{
  "day": "2026-10-10",
  "answers": 42,
  "newAnswers": 11,
  "reused": 31,
  "reusedPct": 73.8,
  "geminiCalls": 187
}
```

- `day`: the current day in Pacific time, which is how Google counts the daily Gemini quota.
- `answers`: answers served that day by `/api/stocks` and `/api/votes` (errors are not counted).
  `newAnswers` needed new Gemini calls; `reused` came from the cache; `answers = newAnswers + reused`.
- `reusedPct`: `reused / answers` in percent, one decimal; `0` when nothing was served yet.
- `geminiCalls`: every Gemini call the app made that day, all models and endpoints (table
  `gemini_usage`), so it also includes the manager's note and failed attempts.
- No request body, no cache. `503 storage_error` when the database cannot be read.

```powershell
Invoke-RestMethod https://prophetf.vercel.app/api/savings
```

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

Runs only the analyst (and reports what the gate would say). The signals analyst makes one Gemini call on the
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
    "warnings": [
      "Signals analyst: keyword search; market-to-ticker sensitivities from the weighting research."
    ]
  },
  "gate": { "passed": true, "summary": "passed: 15 of 15 markets usable" },
  "trace": [
    {
      "step": "analyst",
      "status": "ok",
      "ms": 720,
      "summary": "15 markets, 2 themes, 39 ticker signals (signals)"
    },
    { "step": "gate", "status": "ok", "ms": 0, "summary": "passed: 15 of 15 markets usable" }
  ]
}
```

`packet` is the full packet, including markets the gate would not use. Errors: `400 invalid_request`,
`429 rate_limited` (30 per minute and 600 per day per IP), `502 upstream_error`.

**Which analyst answers** is set by the `ANALYST_MODE` env var (shown in `GET /api/health` under
`pipeline.analystMode`):

| `ANALYST_MODE`      | Analyst                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `signals` (default) | Built in, on the weighting teammate's method (`/backend`): its 11 tracked Polymarket markets ("signals") and their per-ticker sensitivities (betas) link markets to tickers. One Flash-Lite call turns the idea into 3 to 6 search queries and the sectors it touches (cached 24 hours, 5 s limit, keywords instead when it fails or the budget is used up), then Polymarket search, and 24-hour and 7-day changes from the odds history in Tiger (Polymarket's own change fields where Tiger has no history yet). `ANALYST_MODE=mock` is the old name of this mode and still selects it |
| `module`            | `analyze(idea)` exported by `web/src/lib/analyst/index.ts` (HANDOFF option A)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `tiger`             | Reads the tables `analyst_packets` and `market_analysis` (HANDOFF option B)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |

If the `module` or `tiger` analyst throws or returns an invalid packet, the signals analyst answers instead; the
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

**Eval.** `pnpm eval:decider` in `/web` runs the decider on 10 fixed ideas with fixed hand-written packets
(`web/src/lib/pipeline/evalCases.ts`) and prints, per case and in total: whether the first answer passed
every checker rule, whether the final answer did, whether every number in it is grounded in the cited
markets, the Gemini calls, the latency, and how many reasons paste a market question word for word. It runs on
the decider's Flash-Lite chain (about 1 minute, 9 calls); `--model <id>` tries another model first, and any
model that is not Flash-Lite has 20 requests per day, so ask Lucas first. Run it before
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

## 2b. Event risk — `POST /api/risk`

How much a basket moves **if each linked Polymarket event happens, or doesn't**. Takes any basket (the
same body as `POST /api/weights`; `idea` is optional and ignored) and uses the same live markets and
per-stock sensitivities. Nothing is reweighted.

For each live market linked to at least one holding, with p its current probability and β the basket's
weighted sensitivity (1.0 = 10% per 100-point odds move):

- `ifYesPct` = β × (1 − p) × 10: the basket's move if the event happens (odds go to 100%)
- `ifNoPct` = −β × p × 10: its move if it doesn't (odds go to 0%)

Weighted by the market's own odds the two average to zero: **the odds show how much is at stake, not
which way to bet.** This is a scenario stress test, not value at risk. The sensitivities are hand-set
estimates assumed to scale linearly; in our research only some were confirmed by data (Fed odds →
Treasuries and homebuilders is the cleanest). Show `basis` and `note` near the numbers.

### Request

```json
{
  "holdings": [
    { "symbol": "TLT", "weightPct": 40 },
    { "symbol": "JPM", "weightPct": 30 },
    { "symbol": "AAPL", "weightPct": 30 }
  ]
}
```

Same rules as `/api/weights`: at least 1 holding, unique symbols (case-insensitive), weights 0–100
totalling 100 within 0.01.

### Success response — `200`

```json
{
  "markets": [
    {
      "title": "US recession by end of 2026?",
      "url": "https://polymarket.com/event/us-recession-by-end-of-2026",
      "probability": 0.065,
      "observedAt": "2026-10-10T16:34:36.875Z",
      "ifYesPct": 1.496,
      "ifNoPct": -0.104,
      "drivers": [
        { "symbol": "TLT", "weightPct": 40, "beta": 0.7, "ifYesPct": 2.618 },
        { "symbol": "JPM", "weightPct": 30, "beta": -0.4, "ifYesPct": -1.122 }
      ]
    }
  ],
  "uncovered": [],
  "basis": "Sensitivities are hand-set estimates per stock and market, assumed linear in the odds. …",
  "note": "Event probabilities indicate risk, not expected returns: …"
}
```

(Live answer from 2026-10-10, shortened to one market.)

| Field                | Type   | Guarantee                                                                                                     |
| -------------------- | ------ | ------------------------------------------------------------------------------------------------------------- |
| `markets`            | array  | Live markets linked to any holding, largest swing (`ifYesPct − ifNoPct`) first; `[]` if none                  |
| `markets[].ifYesPct` | number | Basket move in percent if the event happens; rounded to 0.001                                                 |
| `markets[].ifNoPct`  | number | Basket move in percent if it doesn't; rounded to 0.001                                                        |
| `markets[].drivers`  | array  | Linked holdings (symbols echoed as sent), largest contribution first; their `ifYesPct` add up to the market's |
| `uncovered`          | array  | Symbols no live market is linked to: show "no measurable event exposure"                                      |
| `basis`, `note`      | string | Caveats to display with the numbers                                                                           |

Errors: `422` (invalid body, duplicate symbols, weights not totalling 100), `429` (over 60 requests a
minute from one IP, with `Retry-After`), `502` (Polymarket lookup failed), all in the common
`{ "error": { "code", "message" } }` shape. Same CORS origins as the other endpoints. Live odds are
shared with `/api/weights` and cached for 60 seconds.

### Try it

```bash
curl -X POST https://prophetf.vercel.app/api/risk -H "Content-Type: application/json" -d '{"holdings":[{"symbol":"TLT","weightPct":40},{"symbol":"JPM","weightPct":30},{"symbol":"AAPL","weightPct":30}]}'
```

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

## 5. `GET /api/built-with` — LIVE (Tiger Data, Gemini, ElevenLabs)

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
  }
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

`sponsors` has one entry each for `tiger`, `gemini`, `elevenlabs` and `ws` (a live-feed flag that is off). The response
also carries `"gemini"`: the model chains and, per model, `usedToday`, `dailyBudget` (80% of the limit),
`remainingToday`, `limitPerDay`, `blockedUntil` and `blockedBecause`, for example
`{ "model": "gemini-3.5-flash-lite", "usedToday": 75, "dailyBudget": 400, "remainingToday": 325, "limitPerDay": 500, "blockedUntil": null, "blockedBecause": null }`.
It also carries `"pipeline": { "analystMode": "signals", "checkerLlm": false }`: which analyst writes the evidence
packet for `/api/stocks` (section 1b) and whether the checker's LLM review is on.

---

## 8. The Python service in `/backend` (reference, not deployed)

The weighting method is owned by the Polymarket teammate and lives in `/backend` (FastAPI, local port 8001;
see `/backend/README.md`). It is not deployed publicly; `POST /api/weights` above is its TypeScript port.
Its other endpoints (`/api/signals`, `/api/basket`, `/api/backtest`, …) exist only in the Python service.

Both services read the same 40 tickers and 11 signals from
`/backend/src/polyslice_api/data/universe.json`. After that file changes, run `pnpm sync:universe` in `/web`
and redeploy.
