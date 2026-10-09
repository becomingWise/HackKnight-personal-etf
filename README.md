# MyETF — Personal portfolio lab

A HackKnight demo for building a personal investment basket with fictional companies and mock prices. Choose interests, select three to five companies, adjust weights and a pretend budget, then explore hypothetical price changes.

The app is an educational simulator. It does not create or trade an ETF, connect to a brokerage, or use live market data.

## Run it

From this repository folder, with Python 3 installed:

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

Open [http://127.0.0.1:8000](http://127.0.0.1:8000). Use a local server rather than opening `index.html` directly: the app uses JavaScript modules and fetches its local JSON dataset.

With Node.js available, `npm start` runs the same server. No dependency installation is needed.

## Try the demo

1. Start with the preselected Sunbeam Solar / Nimbus Cloud / Pulse Health basket.
2. The $1,000 pretend budget at 50% / 30% / 20% allocates $500 / $300 / $200, or 5 / 6 / 10 simulated units.
3. Set Sunbeam Solar's scenario slider to +10% and Pulse Health's to -10%, leaving Nimbus Cloud at 0%. The resulting value is $1,030 (+3%).
4. Change a weight to make the total invalid, then use **Equal weights** to repair it.
5. Try an interest filter and select another company. Selection changes distribute weights equally.
6. Use **Export basket** to download the calculation and scenario as JSON; **Reset demo** restores the initial example.

Prices and companies are made up. Units are fractional; the simulation ignores trading costs, taxes, and dividends. Scenarios keep the original units fixed and do not rebalance. Weights within 0.01% of 100% are normalized internally to allocate the full budget.

## Team file ownership

| Area | Files | What to change |
| --- | --- | --- |
| Screens and styling | `index.html`, `css/styles.css`, `js/ui.js` | Inputs, company cards, responsive layout, charts and accessibility |
| Portfolio calculations | `js/portfolio.js`, `tests/portfolio.test.js` | Validation, allocation, equal weights and scenario calculations |
| Integration and sample data | `js/app.js`, `data/assets.json` | App state, events, loading and export |

This starter was built locally on `shaun-branch`. Agree on individual owners before editing overlapping files. Use a pull request to combine reviewed work into the team's integration branch.

## Calculation checks

With Node.js 22 or newer:

```sh
npm test
```

The checks cover allocation and units, price scenarios and full loss, invalid input, and allocation conservation when percentages are rounded.

`js/portfolio.js` is a pure module and exports:

- `validateBasket(input, assets)` → an array of readable errors.
- `equalWeightHoldings(assetIds)` → weights totaling 100%.
- `calculateBasket(input, assets)` → budget, holdings, interest totals and largest weight.
- `applyScenario(result, changesPctByAssetId)` → new values and percentage change.

Basket inputs use `{ budget, holdings: [{ assetId, weightPct }] }`. Catalog assets use `{ id, symbol, name, interest, price, description }`. Calculated holdings retain `id` and add `weightPct`, `dollars`, and `units`. Scenario changes use a company ID as a key and a percentage as a value, such as `{ SOLAR_DEMO: 10 }`.

## Hosting

The app is static HTML, CSS and JavaScript. It can run on GitHub Pages without a build step. All asset URLs are relative so it also works under `/HackKnight-personal-etf/`.

The repository already has a `gh-pages` deployment branch. Coordinate publishing with the repository owner and confirm the source in **Settings → Pages** before replacing deployed files. Keep API keys out of client code and commits. An optional AI explainer would need a separate server endpoint to hold its key.
