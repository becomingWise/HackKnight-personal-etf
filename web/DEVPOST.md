# ProphETF — Devpost draft

> Draft by the backend side. Paragraphs marked **TODO** need the frontend teammate, the weighting teammate or
> Lucas. Everything else describes what is deployed at https://prophetf.vercel.app today. Numbers come from
> `GET /api/built-with` on 2026-10-10; refresh them before submitting.
>
> We list only what the product really uses: **Gemini, Tiger Data, ElevenLabs and Polymarket data.**

**Tagline:** Turn a hunch into a stock basket that shows its evidence: live prediction-market odds.

## Inspiration

**TODO (Lucas): replace with the team's real starting point.** A neutral version:

Everyone has market opinions: "AI chips are exposed to Taiwan", "rate cuts are coming". Turning one into a
portfolio usually means either guessing or trusting an AI that sounds confident and cites nothing.
Prediction markets are the opposite: thousands of people putting money on exactly those events, with a
price that is a probability. We wanted to connect the two, so that an idea becomes a basket where every
pick comes with a number you can check and watch.

## What it does

1. **You type an idea** in plain language, for example "AI chips and Taiwan risk".
2. **It finds the evidence.** Live Polymarket markets about the events behind the idea, with their current
   odds and how they moved over the last day and week.
3. **It picks 3 to 5 stocks** from a universe of 40 tickers across seven sectors. Each pick has a reason
   that cites a market and its odds, for example: "Polymarket gives 11% that China invades Taiwan by the end
   of 2027, which matters for TSMC because its advanced fabs are concentrated in Taiwan."
4. **It weights the basket** by how the odds moved: a stock that benefits from an event that became more
   likely gets more weight, with the markets behind each tilt listed.
5. **You save and share the basket.** From then on the odds behind it are recorded every minute and charted
   over 1, 7 and 30 days.
6. **It explains itself.** Gemini writes a short manager's note for the basket, and ElevenLabs reads it
   aloud as a one-minute briefing.

When there is not enough evidence, it says so, in plain words, with ideas that do work, instead of inventing
a basket. Every answer also carries a trace of how it was decided.

Paper portfolios for research and fun. Not investment advice. Not affiliated with Polymarket.

**TODO (frontend teammate): two or three sentences on the interface** (the chat flow, the dashboard, what a
visitor sees at each step) and a link to the live site.

## How we built it

**The decision is a workflow, not an agent.** We followed Anthropic's "Building effective agents": a fixed
code path of four small stages, each testable on its own, with one line per stage reported back to the user.

1. **Analyst** — collects Polymarket markets for the idea and analyzes them into one "evidence packet". It
   is built on our teammate's weighting research: 11 tracked Polymarket markets, each with a sensitivity
   (beta) per ticker, say which stocks an event matters for and in which direction.
2. **Gate** — plain code. Fewer than two relevant, liquid, open markets means no AI call and an honest
   "not enough evidence".
3. **Decider** — one Gemini call. It sees the idea, the packet and the 40 allowed tickers, and nothing else.
4. **Checker** — plain code. Allowed tickers, 3 to 5 unique stocks, every cited market exists in the packet,
   every percentage matches the packet within one point. On errors the decider gets exactly one revision.

The backend is a Next.js app on Vercel with API routes only, TypeScript, zod on every external payload, and
287 tests with Gemini and Polymarket mocked. The website is a separate static app that calls it through
three small adapters. The weighting method and the market-to-ticker sensitivities come from a teammate's research in Python,
ported to TypeScript; 88 recorded requests are replayed through the original Python engine to prove the
port gives identical answers.

**TODO (frontend teammate): one paragraph on how the website is built.**
**The research behind it (TODO, weighting teammate: please check and reword).** The sensitivities and the
tilt were studied separately on a 514-stock S&P 500 universe with pre-registered tests and a six-month
holdout that was run once, on 2026-10-10. No test confirmed a return edge, so we present the tilt as an
explanation of how the odds moved, not as a way to beat the market.

## How we used Google Gemini

Gemini makes the decisions that need judgment, and code checks every one of them.

- **Search planning.** One call turns a free-form idea into Polymarket search queries and the sectors it
  touches, so "robots replace warehouse workers" finds the right markets without a keyword list.
- **The final decision.** One call with structured JSON output picks the stocks and writes each reason. The
  packet is its only source of facts, and our checker rejects any ticker, market or percentage that is not
  in it. Gemini gets the checker's exact errors back for a single revision.
- **The manager's note.** A short letter per saved basket, with its numbers verified against the basket
  before it is shown.
- **Evals.** A script runs the decider on 10 fixed ideas with fixed evidence and scores rule compliance and
  grounding. Our first prompt change came from it: one model pasted the market question into every reason
  (29 of 29); after the change, 0 of 31, with 9 of 9 answers passing on the first try.
- **Free tier, no billing.** One file lists our models, their limits and a fallback order per task. Each
  model may use 80% of its quota, counted in the database; when the budget is gone the app answers from the
  evidence alone, in the same shape, rather than failing.

## How we used Tiger Data

Tiger Cloud (Postgres + TimescaleDB) is the only datastore, and the time-series features carry the product.

- **Hypertable.** `odds_ticks` holds every probability we observe (about 19,800 ticks for 201 markets so
  far), with the columnstore on chunks older than a day, segmented by market.
- **Continuous aggregate.** `odds_1h` keeps hourly candles with a refresh policy; week and month charts read
  it, day charts read the raw ticks.
- **Gap-filled charts in one query.** `time_bucket_gapfill` with `locf` puts any number of markets on one
  shared time axis: 30 days for a six-market basket (1,446 points) in about 70 ms, a single market's week in
  about 6 ms.
- **A one-minute job** records the odds of every market a saved basket cites, and history is backfilled the
  first time a market is seen. The analyst reads 24-hour and 7-day changes from this history.
- **Everything else too:** baskets, a response cache shared by all serverless instances, rate limits,
  per-model AI budgets, and the audio files.
- `GET /api/built-with` shows the live row counts, chunks, policy jobs and query latencies.

## How we used ElevenLabs

Every saved basket can be heard. The manager's note is rewritten as a spoken script (company names instead
of tickers, rounded numbers) and sent to ElevenLabs text-to-speech (`eleven_flash_v2_5`). The result is a
one-minute briefing: one MP3 per basket, stored in Tiger and streamed with seeking support. If ElevenLabs is
unavailable the script is still returned as text.

## How we used Polymarket data

Polymarket is our evidence, read-only: public market search, current prices and price history, with no
trading, keys or wallets. We use a market's midpoint as its probability (the last trade when the spread is
wide) and refuse resolved, never-traded or illiquid markets as evidence.

## Challenges we ran into

- **Making an LLM cite real numbers.** Early answers quoted odds that were close but wrong, or cited markets
  that did not exist. The fix was structural: the model only sees a packet, and code verifies every
  percentage and every market id against it.
- **A free AI quota.** We exhausted a model's daily quota in one afternoon of testing. That forced the
  design we should have had from the start: per-model budgets in the database, a fallback chain, caching,
  and a no-AI answer path, so a busy demo degrades instead of breaking.
- **Saying "I don't know".** An idea with no relevant market used to get a forced basket. The gate now stops
  it before any AI call and tells the user why, with examples that work.
- **Two languages, one method.** The weighting research is Python; the deployed service is TypeScript.
  Replaying recorded requests through both keeps them identical, down to rounding.
- **Serverless and a database without a pooler.** Many short-lived instances share three connections each,
  so the cache, rate limits and budgets all live in the database rather than in memory.

## Accomplishments that we're proud of

- Every stock in every answer is tied to a live market, and a wrong number cannot reach the user.
- The whole path works end to end on live URLs: idea → stocks → weights → saved basket → odds charts → note
  → audio.
- The app tells you how it decided (the trace) and proves what it runs on (`/api/built-with`).
- It survives its own dependencies failing: no AI, no audio or no fresh evidence each have a defined,
  honest fallback.

## What we learned

- A fixed workflow with a code gate and a code checker beat a clever prompt. Most of the reliability came
  from what the model is not allowed to do.
- Evals are cheap and change decisions: ten fixed cases were enough to catch a style problem and to choose
  a model.
- Prediction-market odds are a good interface between news and portfolios: a single number people already
  understand.
- Budget for quota on day one.

## What's next

- More tracked markets behind the analyst: today 11 markets carry sensitivities; the research universe
  already covers 514 stocks.
- More tickers and sectors; today an idea outside the seven sectors is declined.
- Tracking how a saved basket would have done as its odds moved.
- Alerts when the odds behind a saved basket move sharply.

## Built with

Next.js, TypeScript, Vercel, Google Gemini API, Tiger Data (Postgres + TimescaleDB), ElevenLabs,
Polymarket public APIs, zod, vitest, Python (weighting research). **TODO (frontend teammate): add the
website's stack.**
