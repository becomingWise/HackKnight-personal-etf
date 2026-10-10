# AGENTS.md — shared rules for every AI tool on this repo

Read this before any change. It decides who owns what. Details per area live in the files linked below.

## Team and ownership

| Owner | Area | Files they own |
| --- | --- | --- |
| 🟠 Shaun — framework | Shared controller and contracts | `js/controller.js`, `js/services.js`, `data/chat-demo.json`, `docs/team-contracts.md` |
| 🟣 Kieran — website | UI | `index.html`, `css/`, `js/ui.js`, `js/app.js`, `js/config.js` |
| 🟢 Hao — Polymarket | `adjustWeights`, `/api/weights`, `/api/risk`, research | `backend/` (Python reference engine), `polymarket/`, `js/weights-api.js`, `js/weights-adapter.js` |
| 🔵 Lucas — Google/backend | `findStocks`, `/api/stocks`, the Next.js API on Vercel | `agent/`, `backend/server.js`, `js/stock-api.js`, `js/stocks-adapter.js`, `js/baskets-adapter.js`, `web/` |

- Edit only files you own. To change someone else's file or a shared contract, ask the owner first.
- Function contracts (`findStocks`, `adjustWeights`, `render`, controller methods): `TEAM_HANDOFF.md`. HTTP contracts: `web/docs/API.md`.
- `web/` details (stack, decisions, Gemini quota rules): `CLAUDE.md` and `web/AGENTS.md`.

## What runs in the demo

- Website: the static root app (`index.html`, `js/`), wired as `createController({ findStocks, adjustWeights })`.
- API: https://prophetf.vercel.app, deployed from `web/`.
  - `POST /api/stocks` runs the agent in `agent/`. `web/` keeps committed copies in `web/src/lib/agent-core/`, refreshed by `pnpm sync:agent`, so after editing `agent/` run it and commit both.
  - `POST /api/weights` is a TypeScript port of `backend/src/polyslice_api/`. The Python engine is the reference: change the method there first, mirror it in `web/src/lib/weights/`, and run `pnpm parity:weights` and `pnpm test`.

## Commands

| Where | Run | Test |
| --- | --- | --- |
| Root (website) | `npm start` (port 8000) | `npm test` |
| `web/` | `pnpm dev` | `pnpm test`, `pnpm lint`, `pnpm typecheck` |
| `backend/` | `uv run uvicorn polyslice_api.main:app --reload --port 8001` | `uv run pytest` |

Run the tests for every area you touched before opening a PR. CI (`.github/workflows/ci.yml`) runs all of them on every PR; a red check means fix it before merging.

## Git

- One short branch per task (`feat/…`, `fix/…`). `git pull` on `main` before you start.
- Small PRs, merged to `main` every few hours. Never push straight to `main`.
- Never merge, rebase or delete someone else's branch.

## Never

- Commit secrets. Keys go in `.env` / `.env.local` (git-ignored); commit only `.env.example`.
- Add a dependency, or touch another area's lockfile (`web/pnpm-lock.yaml`, `backend/uv.lock`), without asking its owner.
- Burst-test Gemini: the free quota is shared by the whole team (see `CLAUDE.md`, Gemini quota).
- Call Polymarket trading, order or auth endpoints. Polymarket is read-only data.
- Rewrite or reformat code outside your task.
