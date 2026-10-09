# MyETF — chat-first app framework

Describe an idea in natural language, then open a sample stock dashboard. This is the framework for the team’s Google AI stock selection and Polymarket percentage adjustment integrations.

**Current mode: demo only.** Companies are fictional, adjustments are fixed examples, and no live API, trading, or market data is used. The currently published site changes only after a reviewed merge and a separate publish step.

## Run and test

```sh
npm start
```

Open http://127.0.0.1:8000/. No dependency installation is needed. Alternatively, run `python3 -m http.server 8000 --bind 127.0.0.1` from the repository folder. Use a server rather than opening the HTML file directly.

With Node.js 22 or newer:

```sh
npm test
```

## Try the flow

1. Type “I care about clean energy” and press Enter or **Build my basket**.
2. The dashboard opens with three fictional companies and equal starting weights: 33.33%, 33.33%, 33.34%.
3. A simulated adjustment changes those weights to 50%, 30%, 20%, with an explicit demo explanation.
4. **Edit my idea** preserves the text for another attempt. **Start over** clears it.
5. Try “I like sailing” or another unsupported idea: the generic example is clearly labeled, and its weights stay equal.

The mock has technology, clean energy, and healthcare fixtures plus a generic fallback. It recognizes a few example keywords across languages; it does not translate or understand arbitrary natural language. The live Google adapter will provide that capability.

## Team handoffs

Start with [Architecture and user flow](docs/architecture.md) and [Team ownership and API contracts](docs/team-contracts.md).

| Owner | Work |
| --- | --- |
| Shaun | Controller, shared flow, hash navigation, mock services, validation, architecture |
| Website teammate | Chat/dashboard markup, styling, rendering, accessibility |
| Google API teammate | Backend Gemini calls, verified stock identities, `findStocks` adapter |
| Polymarket teammate | Market mapping and weighting methodology, `adjustWeights` adapter |

The website consumes controller snapshots. The two integration teammates implement replaceable async adapters. Coordinate entrypoint changes with Shaun so the interfaces remain consistent.

## Collaborate on GitHub

Accept the private repository invitation, then clone once:

```sh
git clone https://github.com/becomingWise/HackKnight-personal-etf.git
cd HackKnight-personal-etf
```

Create a task branch from the latest shared main:

```sh
git fetch origin
git switch -c your-feature-name origin/main
```

Commit only your intended files, push your branch, and open a pull request into `main`. Have a teammate review it before merging. Update your feature branch after shared changes merge:

```sh
git fetch origin
git merge origin/main
```

## Publish after review and merge

Website: https://becomingwise.github.io/HackKnight-personal-etf/

The static frontend is hosted from `gh-pages`. From your local checkout:

```sh
python3 scripts/publish_pages.py
```

The script publishes committed `origin/main`, not unmerged local work, and includes all chat runtime modules and fixtures. It preserves deployment history and does not force-push. GitHub Pages builds the site; `version.json` records its source commit. Updates to main do not deploy automatically.

A future live Google integration requires a separately hosted backend holding its key. GitHub Pages serves static files only. Keep credentials out of client code and commits.

The old pure portfolio calculations and their tests remain available independently; the new entry experience does not expose the old budget, sliders, or export controls.
