import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { createSuggestions, previewSuggestions, COMPANIES } from "./suggestions.js";
import { loadSnapshot, refreshSnapshot, saveSnapshot, stockEvents } from "./data.js";
import { loadAgentEnv } from "../agent/env.js";
import { AgentError } from "../agent/gemini.js";

const FILES = {
  "/": ["./index.html", "text/html"],
  "/app.js": ["./app.js", "text/javascript"],
  "/math.js": ["./math.js", "text/javascript"],
  "/styles.css": ["./styles.css", "text/css"],
  "/capitalization.example.json": ["./capitalization.example.json", "application/json"],
};

export async function createExperimentServer(deps = {}) {
  let snapshot = deps.snapshot ?? await loadSnapshot();
  const suggest = deps.suggest ?? createSuggestions();
  let refreshing = null;
  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    const send = (status, data) => {
      res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(data));
    };
    // Loopback-only and same-origin. No deploy, no team's DB, no production mutations.
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`) return send(403, { error: { message: "Open the local experiment directly." } });
    try {
      if (req.method === "GET" && FILES[url.pathname]) {
        const [path, type] = FILES[url.pathname];
        const data = await readFile(new URL(path, import.meta.url));
        res.writeHead(200, { "Content-Type": `${type}; charset=utf-8`, "Cache-Control": "no-store" });
        return res.end(data);
      }
      if (req.method === "GET" && url.pathname === "/api/overview") {
        return send(200, { builtAt: snapshot.builtAt, note: snapshot.note, geminiConfigured: Boolean(process.env.GEMINI_API_KEY),
          stocks: COMPANIES.map(s => ({ ...s, lastClose: snapshot.stocks[s.symbol]?.prices.at(-1) ?? null,
            eventCount: snapshot.events.filter(e => e.linkedSymbols.includes(s.symbol) && e.status === "available").length })),
        });
      }
      if (req.method === "GET" && url.pathname === "/api/events") {
        const symbol = url.searchParams.get("symbol");
        if (!COMPANIES.some(s => s.symbol === symbol)) return send(400, { error: { message: "Unknown company ticker." } });
        return send(200, { symbol, builtAt: snapshot.builtAt, events: stockEvents(snapshot, symbol) });
      }
      if (req.method === "POST" && url.pathname === "/api/refresh") {
        if (!refreshing) refreshing = (deps.refresh ?? refreshSnapshot)().then(async data => {
          await (deps.save ?? saveSnapshot)(data); snapshot = data; return data;
        }).finally(() => { refreshing = null; });
        await refreshing;
        return send(200, { builtAt: snapshot.builtAt });
      }
      if (req.method === "POST" && url.pathname === "/api/stocks") {
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (Buffer.byteLength(raw) > 16384) return send(413, { error: { message: "The request is too large." } });
        }
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, { error: { message: "Use a JSON request." } }); }
        if (typeof body?.idea !== "string" || !body.idea.trim() || body.idea.length > 500) return send(400, { error: { message: "Enter an idea between 1 and 500 characters." } });
        if (body.mode === "preview") return send(200, previewSuggestions(body));
        if (body.mode !== "gemini") return send(400, { error: { message: "Choose preview or Gemini suggestions." } });
        if (!process.env.GEMINI_API_KEY && !deps.suggest) return send(503, { error: { message: "Set GEMINI_API_KEY in this experiment's agent/.env to enable Gemini suggestions." } });
        const abort = new AbortController();
        res.on("close", () => { if (!res.writableEnded) abort.abort(); });
        return send(200, await suggest({ idea: body.idea }, { signal: abort.signal, sessionId: req.headers["x-session-id"] }));
      }
      return send(404, { error: { message: "Unknown experiment route." } });
    } catch (err) {
      return send(err instanceof AgentError ? err.status : 502, { error: { message: err.message } });
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  loadAgentEnv();
  // Optional key-only configuration comes from this checkout, never a teammate's env file.
  const port = Number(process.env.EXPERIMENT_PORT ?? 8790);
  (await createExperimentServer()).listen(port, "127.0.0.1", () => console.log(`Basket Lab: http://127.0.0.1:${port}`));
}
