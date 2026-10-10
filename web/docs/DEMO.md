# The 2-minute demo

One story, one idea, six beats. We show only what the product really uses: Gemini, Tiger Data, ElevenLabs
and Polymarket data.

**The idea to type: `AI chips and Taiwan risk`.** It is kept cached, so it answers at once. Backups:
`Fed rate cuts and housing`, `Crypto regulation`, `Clean energy after the election`.

> The clicks below assume the website is wired to the backend. **TODO (frontend teammate): replace the
> "On screen" column with the real screens and buttons.** Until then, the same demo runs from the terminal;
> see "Plan B" at the end.

## Script

| Time      | On screen                                                                       | Say                                                                                                                                                                                                                                                                                            |
| --------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:15 | The empty start screen                                                          | "Everyone has a market opinion. Turning it into a portfolio means guessing, or trusting an AI that cites nothing. ProphETF turns an idea into a stock basket where every pick shows its evidence: live prediction-market odds."                                                                |
| 0:15–0:40 | Type **AI chips and Taiwan risk**, submit. The stocks appear with their reasons | "It found live Polymarket markets about this idea, and Gemini picked these stocks. Read one reason: Polymarket gives about eleven percent that China invades Taiwan by 2027, and that is why TSMC is here. That number is live, and our code checked it against the market before you saw it." |
| 0:40–0:55 | Open the "how this was decided" trace                                           | "This is not a black box. Four steps: an analyst gathers the evidence, a gate checks there is enough of it, Gemini decides, and a checker verifies every ticker, market and percentage. If the evidence is thin, it says so instead of inventing an answer."                                   |
| 0:55–1:10 | Continue to the weights. Point at one changed weight and its market             | "Then the basket is weighted by how the odds moved this week. _(Read the tilt on screen, for example:)_ the odds of new chip export rules fell, so Nvidia's weight went up. Each tilt lists the market behind it."                                                                             |
| 1:10–1:30 | Save the basket. Open the odds chart, switch 7 days → 30 days                   | "Save it, and it gets a link. From now on the odds behind it are recorded every minute in Tiger Data. This chart is one TimescaleDB query: thirty days, every market on one time axis, in about seventy milliseconds."                                                                         |
| 1:30–1:50 | Open the manager's note, press play on the audio briefing (let 5 seconds play)  | "Gemini writes a short manager's note for the basket, and ElevenLabs reads it to you." _(let it play, then talk over it)_                                                                                                                                                                      |
| 1:50–2:00 | The built-with proof (or the start screen again)                                | "Everything you saw is live: real markets, real odds, numbers a checker verified. An idea in, a basket that shows its evidence out. That is ProphETF."                                                                                                                                         |

### If a judge asks

- **"What if Gemini is wrong?"** It can only pick from 40 tickers and only cite markets we handed it. Code
  rejects anything else and asks for one revision; a wrong percentage cannot reach the screen.
- **"What if there is no market for my idea?"** Try it: `Underwater basket weaving championships`. It
  declines in plain words and suggests ideas that work.
- **"Is this trading?"** No. Paper portfolios; Polymarket is read-only data; nothing is bought.
- **"How do you stay within a free AI quota?"** Answers are cached, each model has a budget tracked in the
  database, and when it is spent the app answers from the evidence alone.
- **"Why TimescaleDB?"** The product is odds over time: a hypertable for ticks, a continuous aggregate for
  hourly candles, gap-filled queries for the charts. `GET /api/built-with` shows the live numbers.

## Before going on stage

Run these from `/web` about ten minutes before. PowerShell.

1. **Keep the demo ideas warm** (leave it running in its own window):

   ```powershell
   pnpm demo:warm --loop
   ```

   All four ideas must show `cached`. It costs no Gemini calls while the odds stand still.

2. **Check the backend and the Gemini budget:**

   ```powershell
   $h = Invoke-RestMethod https://prophetf.vercel.app/api/health
   $h.database.ok
   $h.gemini.models | Format-Table model, usedToday, remainingToday, blockedUntil
   ```

   `gemini-3.5-flash-lite` or `gemini-3.1-flash-lite` should have budget left. If both are at 0, the cached
   demo ideas still work; do not type new ideas.

3. **Check the demo idea answers from the cache** (should take well under a second and say `cached: True`):

   ```powershell
   $r = Invoke-RestMethod -Method Post -Uri https://prophetf.vercel.app/api/stocks -ContentType "application/json" -Body '{"idea":"AI chips and Taiwan risk"}'
   $r.cached; $r.stocks | Format-Table symbol, name
   ```

4. **Have a saved basket ready** with its note and audio already made, in case saving is slow on stage. Open
   its link in a second tab. To make one from the terminal, see Plan B, steps 3 to 5.

5. Sound on, volume tested, for the audio beat.

## Plan B: the same demo from the terminal

If the website is not connected in time, this shows every beat against the live backend.

```powershell
$api = "https://prophetf.vercel.app"
$json = @{ ContentType = "application/json; charset=utf-8"; Method = "Post" }

# 1. Idea → stocks, each with a reason that cites live odds
$s = Invoke-RestMethod @json -Uri "$api/api/stocks" -Body '{"idea":"AI chips and Taiwan risk"}'
$s.stocks | Format-List symbol, name, reason

# 2. How it was decided
$s.trace | Format-Table step, status, summary

# 3. Weights tilted by the odds moves (equal weights in, tilted weights out)
$n = $s.stocks.Count
$holdings = @($s.stocks | ForEach-Object { @{ symbol = $_.symbol; weightPct = [math]::Round(100 / $n, 2) } })
$holdings[-1].weightPct = [math]::Round(100 - ($holdings[0].weightPct * ($n - 1)), 2)
$w = Invoke-RestMethod @json -Uri "$api/api/weights" -Body (@{ idea = "AI chips and Taiwan risk"; holdings = $holdings } | ConvertTo-Json -Depth 5)
$w.holdings | Format-Table symbol, weightPct
$w.explanation

# 4. Save the basket and get its link
$b = Invoke-RestMethod @json -Uri "$api/api/baskets" -Body (@{ idea = "AI chips and Taiwan risk"; stocks = $s; weights = $w } | ConvertTo-Json -Depth 8)
$b.url

# 5. The odds behind it over 30 days, the manager's note, and the audio briefing
(Invoke-RestMethod "$api/api/baskets/$($b.id)/odds?range=30d").markets | Format-Table question, current, change
(Invoke-RestMethod -Method Post "$api/api/baskets/$($b.id)/letter").letter
$a = Invoke-RestMethod -Method Post "$api/api/baskets/$($b.id)/narrate"
Start-Process $a.audioUrl

# 6. Proof of what it runs on
(Invoke-RestMethod "$api/api/built-with").tiger.rows
```

Step 5 writes a new manager's note and a new audio briefing for a new basket. The note uses the Gemini Flash
models, which have about 16 calls a day each, and the audio spends ElevenLabs characters. Rehearse with one
basket and reuse its id (both are cached per basket) rather than saving a new one each time.

## What never to show or say

Not used, so not mentioned: Snowflake, Solana, Presage, a custom domain. Not offered: trading, real money,
investment advice.
