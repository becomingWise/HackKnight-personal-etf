# 🔵 Lucas's Google/backend agent files

The JavaScript files and `project-notes.json` in this folder are intentionally
empty. The earlier working prototype and its offline tests were saved in
Shaun's local backup before clearing them.

Fill `gemini.js` with one Gemini agent using retrieval, tools, and memory.
Export `findStocks({ idea }, { signal } = {})`. Return a short `summary` and
three stocks containing only `symbol` and `name`; exclude `research` and
`reason`. Use the other files for tools, retrieval, memory, project notes, an
optional equal-weight basket helper, and an optional CLI.

The existing `.env.example` is a configuration template. Local `.env` files are
ignored by Git; keep API keys on the backend.

Fill `../backend/server.js` with the server and `../js/stock-api.js` with the
browser adapter. Read [TEAM_HANDOFF.md](../TEAM_HANDOFF.md) for the exact inputs,
outputs, file ownership, and integration with Polymarket and the website.
