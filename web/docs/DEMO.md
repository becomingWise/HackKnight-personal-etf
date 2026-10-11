# The 2-minute demo

One browser tab on **https://prophetf.vercel.app**, eight steps, 120 seconds. Everything shown is
live. We name only what the product uses: Gemini, Tiger Data, ElevenLabs, and Polymarket and Kalshi
data.

**Type exactly these two ideas:** `car`, then `AI chips and Taiwan risk`. Both are warmed by
`pnpm demo:warm`, so they answer from the cache.

## Script

| #   | Time      | Do                                                                                               | Say                                                                                                                                                                                                                              | If Gemini is slow                                                                                            |
| --- | --------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 1   | 0:00–0:10 | The Build page, empty                                                                            | "Everyone has a market opinion. ProphETF turns it into a stock basket backed by live prediction-market odds, and it is honest about what it does not know."                                                                      | Nothing loads here; just start.                                                                              |
| 2   | 0:10–0:25 | Type `car`, press Enter. The question and three buttons appear                                   | "Watch what it does with a vague idea. It does not force a basket. It says: we don't cover carmakers yet, and offers three ideas it can build. Gemini has to judge the idea before it may pick a single stock."                  | Type `???` instead: the free pre-check answers at once with three ideas. Say "it asks instead of guessing".  |
| 3   | 0:25–0:45 | Clear the box, type `AI chips and Taiwan risk`, Enter. Point at the three steps, then the basket | "A clear idea. It reads the Polymarket odds, a Gemini agent picks three stocks out of forty, and five more agents vote. Here is the basket: TSMC, Nvidia, AMD, each with its weight."                                            | Click the first example chip, "AI chips and Taiwan risk": the same idea, answered from the cache.            |
| 4   | 0:45–1:05 | Scroll to **Why these weights**. Point at one row, one market card, one "If yes / If no" line    | "The weights start equal and are tilted by how the odds moved this week. This market, China invading Taiwan, is at eleven percent. And this line is the stress test: how far the basket moves if it happens, and if it doesn't." | Weights and risk do not use Gemini. If the section is empty, say "the odds feed is catching up" and move on. |
| 5   | 1:05–1:20 | Scroll to **What five AI agents think**. Point at the headline, then one agent's record          | "Five agents with different jobs vote: a growth investor, a risk analyst, a macro analyst, a skeptic and a fit checker. Each gives a probability that this basket beats the S&P 500 next week. And next to each: its record."    | If the panel still says "voting…", go to step 6 now and say "while they vote, here is how they have done".   |
| 6   | 1:20–1:35 | Click an agent's record (or **Track record** in the header)                                      | "We graded our own AI. Eighty decisions, replayed week by week with no hindsight, scored against the S&P 500. The result: a coin flip. Every range includes fifty percent, and we show it."                                      | This page is a database read, no AI. If it is slow, open `docs/product/desktop-6-track-record.png`.          |
| 7   | 1:35–1:52 | Browser Back, click **Paper-trade this basket →**. Buy `1000`. Open one event, drag the slider   | "So don't take its word: paper-trade it. One click sends the basket to the Lab. A thousand paper dollars. Now pick an event and move its odds: this is what the basket's history says could happen. No real money anywhere."     | The Lab never calls Gemini. If the hand-off fails, open `/lab/basket?symbols=TSM,NVDA,AMD` directly.         |
| 8   | 1:52–2:00 | Click **How it works**                                                                           | "One page for how it works: Gemini decides, Tiger Data keeps every odds reading and every call, ElevenLabs reads your saved basket aloud. All live numbers. That is ProphETF."                                                   | The numbers are database counts. If they show a dash, say "and these fill in live" and end on the diagram.   |

**Lines worth saying word for word**

- Step 2: "It asks instead of guessing."
- Step 6: "We graded our own AI: a coin flip, and we show it."
- Step 7: "No real money anywhere."

**If there are 20 spare seconds** (a recorded video, or a judge who wants more): on the Build page
press **Save & share**, read one line of the manager's note, press **Listen** and let five seconds of
the ElevenLabs briefing play. For a live demo, save the basket beforehand and open its `/b/…` page:
saving a new basket writes a new note, which uses a Gemini model with only 20 requests a day.

## If a judge asks

- **"Is the AI any good at picking?"** We measured it: 51% to 58% right per agent over 80 decisions,
  the panel 50%. Not distinguishable from a coin flip on eight weeks, and the site says so.
- **"Then what is the point of the odds?"** They are a live read on risk. Our event study found a real
  same-day reaction to sharp odds moves (69% in the predicted direction) and no reliable edge for the
  following week. So we show odds as what is at stake, never as a tip.
- **"What if I type nonsense?"** Try it. Random keys are stopped for free; a vague or uncovered idea
  gets one question with options.
- **"Is this trading?"** No. Paper portfolios; Polymarket and Kalshi are read-only public data, with no
  keys and no orders.
- **"How do you stay inside a free AI quota?"** Seven small calls for a new idea, none for a repeated
  one: an answer is reused until the odds behind it move three points. Today's numbers are on the How
  it works page.
- **"Why Tiger Data?"** The product is odds over time: a hypertable for the readings, a continuous
  aggregate for the hourly view, and the whole track record as plain SQL.

## Before going on stage

Run from `/web`, about ten minutes before. PowerShell.

```powershell
# 1. Warm the two ideas of the script and the other example chips, and keep them warm.
pnpm demo:warm --loop

# 2. Everything green? Look at "ok", the database, and the Flash-Lite calls left today.
Invoke-RestMethod https://prophetf.vercel.app/api/health | ConvertTo-Json -Depth 5

# 3. The odds tick is running? "lastTickAt" should be within the last few minutes.
(Invoke-RestMethod https://prophetf.vercel.app/api/built-with).tiger.lastTickAt
```

Then, in the browser:

1. Open https://prophetf.vercel.app and run both ideas once by hand. Each should answer in about a
   second.
2. Open the Lab once (`/lab`), so its files are cached.
3. Zoom the browser so the basket and "Why these weights" fit without much scrolling.
4. Leave `pnpm demo:warm --loop` running. Each line should say `reused`. A line that says `new` means
   the odds moved or the cache expired; that idea is warm again from then on.

**What can still go wrong**

- **The `car` question is cached for only 15 minutes.** The loop refreshes it every 10. Without the
  loop it costs one Gemini call on stage (about two seconds).
- **The free daily quota resets at midnight Pacific time.** If `/api/health` shows few Flash-Lite calls
  left, do not try new ideas before the demo; the two scripted ones cost nothing while they are warm.
- **No network:** the screenshots of every step are in `docs/product/` and `docs/lab/`.
