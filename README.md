# MyETF — application framework

Shaun’s contribution is the application logic and team architecture for:

**User idea → stock selection → equal starting weights → Polymarket adjustment.**

This branch adds the controller, mock adapters, fixtures, tests, and handoff documentation. The website teammate owns the chat screen, dashboard, styling, browser navigation, and integration into the website entrypoint. The existing website files are retained as the shared main baseline; they do not run this new framework yet.

## Test the framework without a website

With Node.js 22 or newer, no dependency installation is needed:

```sh
npm test
npm run demo:framework -- "I care about clean energy"
```

The command-line demo prints state transitions and the resulting sample basket. All companies are fictional. Theme examples use fixed 50% / 30% / 20% simulated adjustments; generic examples retain equal weights. No Google or Polymarket API is called.

## Team handoffs

Read [Architecture and intended user flow](docs/architecture.md) and [Team ownership and API contracts](docs/team-contracts.md).

| Owner | Work |
| --- | --- |
| Shaun | Controller, mock adapters, validation, architecture, framework tests |
| Website teammate | Chat/dashboard screens, styling, rendering, hash navigation, application wiring |
| Google API teammate | Backend Gemini calls, verified stock identities, `findStocks` adapter |
| Polymarket teammate | Market mapping and weighting methodology, `adjustWeights` adapter |

The website subscribes to controller snapshots and invokes its methods. The integration teammates supply async adapters. No frontend design is included in Shaun’s framework change.

## Start a team task

Accept the private repository invitation and clone once:

```sh
git clone https://github.com/becomingWise/HackKnight-personal-etf.git
cd HackKnight-personal-etf
```

Until the framework PR merges, create a task branch from it:

```sh
git fetch origin
git switch -c your-feature-name origin/chat-framework
```

After it merges, start new tasks from `origin/main`. Commit your intended files, push your branch, and open a PR into main for teammate review. Coordinate any shared edits.

## Existing website and deployment

The previous portfolio demo remains on main and at https://becomingwise.github.io/HackKnight-personal-etf/. `npm start` serves that existing website at http://127.0.0.1:8000/; it does not demonstrate the new framework.

The website teammate will connect the framework and update `scripts/publish_pages.py` to include the runtime modules and fixtures it uses. Publishing remains a separate step after review and merge:

```sh
python3 scripts/publish_pages.py
```

A future live Gemini integration needs a separately hosted backend holding the API key. GitHub Pages serves static files only. Keep credentials out of client code and commits. The existing calculation module and its tests remain available.
