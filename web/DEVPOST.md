# ProphETF — Devpost submission draft

**Tagline:** Turn an idea into a stock basket, backed by live prediction-market odds.

**Live:** https://prophetf.vercel.app · **Code:** https://github.com/becomingWise/HackKnight-personal-etf

**Built with**

- **In the product:** Google Gemini API, Tiger Data (Postgres + TimescaleDB), Polymarket and Kalshi
  public data (read-only, no keys), daily stock closes from Yahoo Finance, and ElevenLabs for the
  audio briefing of a saved basket.
- **How we built and run it:** Claude Code, Vercel, cron-job.org, GitHub and GitHub Actions, Next.js
  and TypeScript, Python.

---

## Inspiration

Everyone has a market opinion: "AI chips are exposed to Taiwan", "rates will stay high". Turning that
opinion into a portfolio usually means guessing, or asking an AI that sounds sure and shows nothing.
Prediction markets already put a live number on exactly these events. We wanted a tool that connects
the two, and that is honest about what it does not know: it asks when your idea is unclear, and it
grades its own AI in public.

## What it does

- **You type an idea.** A Gemini agent picks three stocks for it from 40 tickers. If the idea is too
  broad ("money"), not covered ("car") or not an idea at all, it asks one question and offers two or
  three options instead of forcing a basket.
- **Polymarket odds set the weights.** Weights start equal and are tilted by how the odds of the
  linked events moved this week. You see the table, the markets behind it, and how far the basket
  would move if each event happens or does not.
- **Five AI agents vote.** A growth investor, a value and risk analyst, a macro analyst, a skeptic
  and a fit checker each vote on every stock and answer one question: will this basket beat the
  S&P 500 next week?
- **We keep score.** Every call is stored and graded a week later. The track record page shows each
  agent's share of right calls with its range, next to a coin flip.
- **Paper-trade it.** One click sends the basket to the Lab, where you fund it with paper dollars and
  move an event's odds with a slider to see an illustrative scenario.
- **Save and share.** A saved basket gets a link, a short manager's note, and an audio briefing.

Nothing is bought or sold. These are paper portfolios for research and fun.

## How we built it

One Next.js app on Vercel serves the website and the API. The stock agent is plain JavaScript shared
with a local server; the weights are a TypeScript port of our Python research engine, kept identical
by a parity test; the Lab is a separate small app that a sync script copies in. Everything stored
lives in one Tiger Cloud database. All tests run with the AI and the markets mocked: 416 in the web
app and 133 at the repository root.

### How we used Google Gemini

Gemini is the product's brain in three places. **The stock agent** combines function calling
(a selection checker, session memory, a web-search tool) with structured JSON output. Its answer
schema starts with a `clarity` field, so the model must judge the idea before it writes a single
ticker, and our server refuses a basket unless the idea is clear. **The voting panel** is five Gemini
calls in parallel, each with its own role and its own track record in the prompt. **The manager's
note** of a saved basket is one more call, and every percentage in it is checked against the basket
before anyone sees it. We run entirely on the free tier: each model has a budget counted in the
database with a fallback chain, and an answer is reused for everyone until a Polymarket market it
cites moves three points.

### How we used Tiger Data

Tiger Cloud (Postgres with TimescaleDB) is our only database. Odds are a time series, so
`odds_ticks` is a hypertable with a columnstore policy, a cron job adds one reading per market every
minute, and `odds_1h` is a continuous aggregate over it; charts read both with `time_bucket_gapfill`.
The track record is plain SQL over three tables: stock closes, panel decisions and one row per
agent's vote. The same database holds the saved baskets, the audio files, the response caches, the
rate limits and the Gemini budgets, so our serverless functions share one source of truth.
`/api/built-with` shows the live row counts and query timings.

### How we used ElevenLabs

Press Listen on a saved basket and ElevenLabs reads its manager's note as a briefing of about one
minute. We prepare the script for the ear first: tickers become company names and weights are
rounded. Each basket is narrated once; the MP3 is stored in Tiger and streamed from our own endpoint
with byte ranges, so seeking works on every browser. If ElevenLabs is unavailable, the briefing is
shown as text.

## Challenges we ran into

- **A free-tier quota.** Some Gemini models allow only 20 requests a day, and one afternoon of
  testing used a whole day's allowance. We moved every routine call to Flash-Lite, gave each model a
  budget tracked in the database, and reuse an answer until the odds behind it move. A new idea now
  costs seven small calls and a repeated one costs none.
- **Unclear ideas.** At first "food", "money" and "banana dance" each got a confident basket. Telling
  the model it may ask was not enough: it picked stocks first and then stuck with them. Making it
  state `clarity` before anything else, and enforcing that in code, fixed it: in our live check, 7 of
  7 clear ideas got a basket and 12 of 12 unclear ones got a question.
- **No hindsight in the replay.** To have a track record on day one we replayed eight past Fridays.
  Each agent saw only the prices and odds known on that Friday, and only the part of its own record
  that had already ended. We also checked that the models could not simply remember the answer: one
  model's documented training cutoff and the other's own stated cutoff are before the replay window,
  and neither knew a recent S&P 500 close.

## Accomplishments that we're proud of

- **An honest track record.** Over 80 replayed decisions the agents were right 51% to 58% of the
  time and the panel's majority 50%. Every range includes 50%. That is a coin flip, and the product
  says so on its own page instead of hiding it.
- **The clarify flow.** The agent says "We don't cover carmakers yet" and offers three ideas it can
  build, rather than inventing a basket of unrelated large companies.
- **Cost per idea.** Seven Flash-Lite calls for a new idea, zero for a reused one, with the day's
  totals shown live. The whole product runs on free tiers.

## What we learned

- **Prediction-market odds are a real-time read on risk, not a forecast of returns.** Hao's event
  study looked at 61 sharp odds moves on 58 dates between 2023 and 2026. On the day of the move,
  linked stocks went the predicted way 69% of the time (+59 basis points against the S&P 500, far
  from what random dates give). Over the following week there was no reliable edge once the
  sensitivities were estimated without hindsight, and nothing was confirmed on the holdout period.
  So the product shows odds as what is at stake, and never as a tip.
- **Make the model commit to a judgement first.** The order of fields in a structured answer changes
  what the model does.
- **Measure before you claim.** Eight weeks of correlated decisions cannot tell a skilled agent from
  a lucky one. Resampling whole weeks gave us ranges wide enough to be honest.

## What's next

- Keep scoring live decisions every week, so the track record grows beyond the replay.
- More than 40 tickers, and funds in the Lab.
- Let the panel's record feed back: weight an agent's vote by how often it has been right.
- Alerts when the odds behind a saved basket move.

## Team

- **Lucas:** backend, the AI agent, the voting panel, the track record, the website.
- **Hao:** Polymarket weighting research and the weights, event risk.
- **Shaun:** the framework and the paper-trading Lab.
- **Kieran:** website design.

_Paper portfolios for research and fun. Not investment advice. Not affiliated with Polymarket or Kalshi._
