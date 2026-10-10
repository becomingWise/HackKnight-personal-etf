# MyETF — team workspace

**User idea → selected companies → equal starting basket → Polymarket adjustment → website.**

Start with [TEAM_HANDOFF.md](TEAM_HANDOFF.md). It names the exact files each
teammate owns and specifies the function signatures, HTTP endpoints, request
bodies, response bodies, and website wiring.

## Current state

The teammate implementation files are intentionally empty so their owners can
put their code in the right places. The previous Gemini prototype, its tests,
and the previous website were backed up on Shaun's computer outside the Git
repository before clearing these files.

Shaun's shared controller, mock services, fixtures, portfolio calculations, and
framework/calculation tests remain available.

Additional backend implementations live under `web/` and `backend/src/`.
This handoff covers the root application's starter files.

| Owner | Main files to fill |
| --- | --- |
| 🔵 Lucas — Google/backend | `agent/gemini.js`, agent helpers, `backend/server.js`, `js/stock-api.js` |
| 🟢 Hao — Polymarket | `polymarket/weights.js`, `js/weights-api.js` |
| 🟣 Kieran — website | `index.html`, `css/styles.css`, `js/ui.js`, `js/app.js`, `js/config.js` |

Do not include `reason` or `research` in the stock response. The main website
shows company names, tickers, percentages, and an allocation chart.

## Try the shared framework

With Node.js 22 or newer:

```sh
npm test
npm run demo:framework -- "I care about clean energy"
```

These checks use mocks and require no API keys. They do not verify the empty
teammate implementations. Demo companies and adjustments are fictional.

`npm start` serves the website files at `http://127.0.0.1:8000/`. The page is empty
until Kieran fills the files. Live API endpoints need Lucas's implementation
and hosting. Keep Google credentials on that backend.

## More detail

- [Function and API contracts](docs/team-contracts.md)
- [Controller and intended user flow](docs/architecture.md)
- [Website basket display example](docs/website-basket.md)

Use separate feature branches and coordinate shared imports and backend URLs.
Review and merge completed work before publishing. Kieran must
update `scripts/publish_pages.py` to include the browser modules it uses.
