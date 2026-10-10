# Handoff: the analyst and the evidence packet

For the backend teammate who owns the **analyst**. Written 2026-10-10.

## What changed

`POST /api/stocks` is now a fixed four-stage workflow. Each stage is one small function in
`web/src/lib/pipeline/`, and each has one owner:

```
idea ──► a. ANALYST ──► b. GATE ──► c. DECIDER ──► d. CHECKER ──► stocks + trace
         (you)          (code)      (Lucas, Gemini)  (code)
```

- **Analyst (you):** collect Polymarket data for the idea and analyze it. Output: one **evidence packet**.
- **Gate (code):** are there at least 2 relevant, liquid, open markets in a fresh packet? If not, the request
  ends with "not enough evidence" and Gemini is never called.
- **Decider (Lucas):** one Gemini call. It sees the idea, your packet and the 40 allowed tickers, and returns
  3 to 5 stocks. Every reason must cite market ids from your packet.
- **Checker (code):** valid tickers, 3 to 5 unique stocks, every cited market is in the packet, every
  percentage matches the packet. On errors the decider gets one revision.

The decider has **no other source of facts than your packet**. It cannot search, and the checker rejects any
number that is not in the packet. What you put in is what the user gets explained.

Today a **mock analyst** (`web/src/lib/analyst/mock.ts`) fills your seat. It has no intelligence: it matches
keywords to sectors, searches Polymarket, and uses the fixed market → ticker sensitivities from
`universe.json`. Its `signal`, `analystNote`, `themes` and `tickerSignals` are mechanical. Replacing those
with real analysis is your part.

## The evidence packet

Schema: `web/src/lib/analyst/packet.ts` (zod; the type `EvidencePacket` is exported from there). The schema
is the source of truth; `POST /api/decide` validates against it and tells you which field is wrong.

### One full example

```json
{
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
      "liquidity": 12658.73,
      "endDate": "2027-01-01T04:59:00Z",
      "relevance": 0.9,
      "signal": "bullish",
      "analystNote": "Licensing would cap sales of advanced AI chips abroad. The odds fell 9.5 points in a week after the bill stalled in committee, which removes pressure from NVIDIA and AMD."
    },
    {
      "id": "1633611",
      "question": "Will China invade Taiwan by December 31, 2027?",
      "url": "https://polymarket.com/event/will-china-invade-taiwan-by-december-31-2027",
      "probability": 0.105,
      "change24h": 0,
      "change7d": -0.01,
      "volume24h": 1113.26,
      "liquidity": 223330.03,
      "endDate": "2028-01-01T04:59:00Z",
      "relevance": 0.85,
      "signal": "neutral",
      "analystNote": "The main tail risk for leading-edge chip supply: most advanced fabs are in Taiwan. Low and stable."
    },
    {
      "id": "676842",
      "question": "U.S. enacts AI safety bill before 2027?",
      "url": "https://polymarket.com/event/us-enacts-ai-safety-bill-before-2027",
      "probability": 0.045,
      "change24h": 0,
      "change7d": 0,
      "volume24h": 97.39,
      "liquidity": 31619.0,
      "endDate": "2027-01-01T04:59:00Z",
      "relevance": 0.45,
      "signal": "neutral",
      "analystNote": "Unlikely and only loosely tied to chip demand."
    }
  ],
  "themes": [
    {
      "name": "Export controls are easing",
      "direction": "bullish",
      "confidence": 0.7,
      "marketIds": ["1426260"]
    },
    {
      "name": "Taiwan supply risk",
      "direction": "neutral",
      "confidence": 0.6,
      "marketIds": ["1633611"]
    }
  ],
  "tickerSignals": [
    {
      "symbol": "NVDA",
      "impact": 0.6,
      "marketIds": ["1426260", "1633611"],
      "why": "The largest seller of AI chips abroad, so it gains most when export licensing gets less likely."
    },
    {
      "symbol": "TSM",
      "impact": -0.1,
      "marketIds": ["1633611"],
      "why": "Its leading-edge fabs are in Taiwan; any rise in invasion odds hits it first."
    },
    {
      "symbol": "AMD",
      "impact": 0.5,
      "marketIds": ["1426260"],
      "why": "Its data-center chips fall under the same export rules as NVIDIA's."
    },
    {
      "symbol": "INTC",
      "impact": -0.2,
      "marketIds": ["1426260", "1633611"],
      "why": "US-based fabs are worth more when Taiwan risk or export limits rise; both are easing."
    }
  ],
  "warnings": ["Only three markets with real liquidity were found for this idea."]
}
```

### Field by field

| Field                              | Type                                      | Rules and meaning                                                                                                                                                            |
| ---------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idea`                             | string                                    | The user's idea as given, 1 to 500 characters                                                                                                                                |
| `generatedAt`                      | ISO date-time string                      | When the packet was built. Python's `datetime.now(timezone.utc).isoformat()` is fine. **Older than 60 minutes fails the gate.**                                              |
| `markets`                          | array, at most 40                         | **Most relevant first.** Unique ids. May be empty (the gate then says "not enough evidence")                                                                                 |
| `markets[].id`                     | string                                    | Polymarket's numeric market id (Gamma `id`), as a string. Not the condition id, not a token id                                                                               |
| `markets[].question`               | string                                    | The market's question, 1 to 300 characters                                                                                                                                   |
| `markets[].url`                    | URL                                       | `https://polymarket.com/event/<event slug>`                                                                                                                                  |
| `markets[].probability`            | number 0 to 1                             | Current odds of "Yes". Use the midpoint, or the last trade when the spread is wider than 0.10. Markets at exactly 0 or 1 fail the gate                                       |
| `markets[].change24h`, `change7d`  | number -1 to 1, or `null`                 | Change of `probability`, in probability units: `0.03` = up 3 points. `null` when unknown                                                                                     |
| `markets[].volume24h`, `liquidity` | number ≥ 0, or `null`                     | US dollars. **`liquidity` below 1,000 or `null` fails the gate** for that market                                                                                             |
| `markets[].endDate`                | ISO date-time string or `null`            | A date in the past fails the gate for that market                                                                                                                            |
| `markets[].relevance`              | number 0 to 1                             | How much this market matters for the idea. **Below 0.4 fails the gate** for that market, so be honest: 0.9 = directly about the idea, 0.5 = related, 0.2 = same keyword only |
| `markets[].signal`                 | `"bullish"` \| `"bearish"` \| `"neutral"` | What the market's level and recent move mean for the idea's stocks overall                                                                                                   |
| `markets[].analystNote`            | string, 0 to 400 characters               | Your analysis in one or two sentences. The decider reads it and may repeat it. This is the most valuable field                                                               |
| `themes`                           | array, at most 12                         | The few stories that connect the markets                                                                                                                                     |
| `themes[].name`                    | string, 1 to 80 characters                |                                                                                                                                                                              |
| `themes[].direction`               | same three values as `signal`             |                                                                                                                                                                              |
| `themes[].confidence`              | number 0 to 1                             |                                                                                                                                                                              |
| `themes[].marketIds`               | string array                              | Ids from `markets`                                                                                                                                                           |
| `tickerSignals`                    | array, at most 60                         | **Most important first.** If Gemini is down, the first 3 to 5 supported tickers here become the answer, in this order                                                        |
| `tickerSignals[].symbol`           | string                                    | A ticker. Only the 40 in `backend/src/polyslice_api/data/universe.json` can be picked; others are ignored                                                                    |
| `tickerSignals[].impact`           | number -1 to 1                            | Net expected effect of the evidence on the ticker: -1 strongly negative, 0 none, +1 strongly positive                                                                        |
| `tickerSignals[].marketIds`        | string array, at least 1                  | Ids from `markets`. **Put the market that `why` is about first**                                                                                                             |
| `tickerSignals[].why`              | string, 1 to 300 characters               | One sentence that makes sense on its own. In the fallback it is shown to the user right after "Polymarket gives X% to <question>."                                           |
| `warnings`                         | string array, at most 20                  | Anything the decider should know: thin coverage, stale data, evidence that contradicts the idea                                                                              |

Cross-reference rule: every id in `themes[].marketIds` and `tickerSignals[].marketIds` must be the `id` of a
market in `markets`. A packet that breaks this is rejected.

### What makes a good packet

- **5 to 12 markets** that pass the gate are plenty. The decider needs one distinct market per stock where
  possible, so breadth across the idea's angles beats ten variants of one event.
- **Numbers you want quoted must be in the packet.** The decider may quote `probability` as a percentage and
  `change24h` / `change7d` as points, and any number that appears in a market's `question` or `analystNote`.
  Nothing else gets through the checker.
- **`analystNote` and `why` should say why, not what.** "Yes is at 22%" is already in the data. "The bill
  stalled in committee" is analysis.
- **Do not pick the stocks.** `tickerSignals` are hints. The decider may choose another allowed ticker when a
  market clearly matters for it, and it ignores tickers it finds unconvincing.

## How to plug your analyst in: two options

Tell Lucas which one you want. Both are already wired; nothing in the decider changes.

### Option A — a TypeScript module

Write your analyst in `web/src/lib/analyst/` and export one function from `web/src/lib/analyst/index.ts`
(the placeholder there throws today):

```ts
import type { EvidencePacket } from "./packet";

export async function analyze(idea: string, signal?: AbortSignal): Promise<EvidencePacket> {
  // search Polymarket, read odds history, analyze, return the packet
}
```

Then set `ANALYST_MODE=module` (in `web/.env.local` locally; Lucas sets it on Vercel).

- It runs inside the request, so it should answer in **under 5 seconds** (the whole request has 30).
- You can reuse what exists: `searchMarkets(query)` in `src/lib/polymarket/search.ts` (live Yes/No markets
  with price, liquidity, 24-hour and 7-day changes), `fetchMarketsByIds`, `fetchPriceHistory` in
  `src/lib/polymarket/markets.ts`, `tigerPastOdds(ids, now)` and `tigerOddsRepo.series(...)` in
  `src/lib/odds/repo.ts`, and the universe in `src/lib/stocks/universe.ts`.
- Gemini quota is tight (5 requests per minute on the main model). An analyst that calls an LLM needs its own
  key or the lite model; talk to Lucas first.
- Best when: you are fine writing TypeScript and the analysis is quick. One deployment, no extra moving parts,
  works for any idea a user types.

### Option B — your Python job writes to Tiger

Keep your Python code. It writes into two tables that exist now (migration
`web/db/migrations/0007_analyst.sql`, same Tiger database as everything else; ask Lucas for the connection
string). Then `ANALYST_MODE=tiger`.

**Table 1, `analyst_packets`: a finished packet for one idea.**

| Column         | Type        | Notes                                                                 |
| -------------- | ----------- | --------------------------------------------------------------------- |
| `idea`         | text        | The idea text                                                         |
| `packet`       | jsonb       | The EvidencePacket exactly as described above                         |
| `generated_at` | timestamptz | Defaults to `now()`                                                   |
| `idea_key`     | text        | Computed by the database (lower case, single spaces). Do not write it |

```python
cur.execute(
    "insert into analyst_packets (idea, packet) values (%s, %s::jsonb)",
    (idea, json.dumps(packet)),
)
```

Insert a new row to refresh; the newest row for an idea wins, and rows older than 60 minutes are ignored. The
lookup ignores case and extra spaces, nothing else: "AI chips and Taiwan risk" and "ai chips and taiwan
risk" match, "AI chips & Taiwan" does not. So this table suits **known ideas**, for example the four demo
ideas, refreshed by a job every 15 to 30 minutes: "AI chips and Taiwan risk", "Fed rate cuts and housing",
"Clean energy after the election", "Crypto regulation".

**Table 2, `market_analysis`: your analysis of one market, whatever the idea.**

| Column         | Type        | Notes                                                                      |
| -------------- | ----------- | -------------------------------------------------------------------------- |
| `market_id`    | text, key   | Polymarket's numeric market id                                             |
| `signal`       | text        | `bullish`, `bearish` or `neutral`                                          |
| `analyst_note` | text        | Up to 400 characters                                                       |
| `tickers`      | jsonb       | `[{ "symbol": "TSM", "impact": -0.6, "why": "..." }]`, impact from -1 to 1 |
| `analyzed_at`  | timestamptz | Defaults to `now()`; rows older than 24 hours are ignored                  |

```python
cur.execute(
    """insert into market_analysis (market_id, signal, analyst_note, tickers, analyzed_at)
       values (%s, %s, %s, %s::jsonb, now())
       on conflict (market_id) do update set signal = excluded.signal,
         analyst_note = excluded.analyst_note, tickers = excluded.tickers, analyzed_at = now()""",
    (market_id, signal, note, json.dumps(tickers)),
)
```

For an idea with no packet in table 1, the built-in search finds the markets (with live odds, changes,
liquidity and relevance) and your rows replace the mock's `signal`, `analystNote` and ticker links for every
market you have analyzed. So this table covers **any idea a user types**, as far as you have analyzed the
markets it touches. The markets worth analyzing first are the ones in the `markets` table (everything the
app has seen so far).

- Best when: you want to stay in Python, or the analysis is too slow for a request (LLM calls, backfills).
- Cost: a job to run and keep alive; freshness depends on its schedule; ideas you did not precompute only get
  your per-market notes, not your themes or relevance.

### If your analyst fails

In both options, when your analyst throws, times out or returns an invalid packet, the mock analyst answers
that request. The response's `trace` then shows `"analyst"` with `"status": "warn"`, and the first entry of
the packet's `warnings` says what went wrong. Nothing breaks for the user.

## Testing your analyst

Two endpoints let you work without touching the decider (details in `web/docs/API.md`, sections 1b and 1c):

- **`POST /api/analyze`** `{ "idea": "..." }` → `{ packet, gate, trace }`. Shows the packet the configured
  analyst produces and whether it would pass the gate. No Gemini call, so call it as often as you like
  (30 per minute).
- **`POST /api/decide`** `{ "idea": "...", "packet": { ... } }` → the final `/api/stocks` answer for exactly
  that packet. Send a packet you wrote by hand or produced in Python and see what the decider makes of it. A
  schema error comes back as `400` with the field name. This one spends Gemini quota: at most 8 uncached
  requests per minute for everyone together, so no loops please.

```powershell
# What does the current analyst produce?
$a = Invoke-RestMethod -Method Post -Uri "https://prophetf.vercel.app/api/analyze" -ContentType "application/json" -Body '{"idea":"AI chips and Taiwan risk"}'
$a.gate
$a.packet.markets | Format-Table id, probability, relevance, signal, question

# What does the decider make of MY packet? (packet.json = your EvidencePacket)
$packet = Get-Content packet.json -Raw | ConvertFrom-Json
$body = @{ idea = $packet.idea; packet = $packet } | ConvertTo-Json -Depth 8
$r = Invoke-RestMethod -Method Post -Uri "https://prophetf.vercel.app/api/decide" -ContentType "application/json; charset=utf-8" -Body $body
$r.trace | Format-Table step, status, summary
$r.stocks | Format-List symbol, reason
```

Locally (`pnpm dev` in `/web`): the same calls against `http://localhost:3000`, or
`pnpm try:findstocks --packet "your idea"` to print the packet and the gate result.

## Checklist before you say "done"

- [ ] `POST /api/decide` accepts your packet (no `400`).
- [ ] The gate passes for the four demo ideas: `gate.passed` is `true` in `/api/analyze`.
- [ ] `generatedAt` is the real build time and `liquidity` is filled in.
- [ ] Market ids are Gamma market ids; each opens at its `url`.
- [ ] `tickerSignals` is ordered most important first, with at least 3 tickers from the universe.
- [ ] Each `analystNote` says something the numbers alone do not.
