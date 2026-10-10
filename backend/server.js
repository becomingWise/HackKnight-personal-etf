// Local HTTP server for the stock agent (plain Node, no dependencies):
//   node backend/server.js            → http://127.0.0.1:8787
//   POST /api/stocks   { "idea": "..." }  → { summary, stocks: [{ symbol, name }] }   (agent/gemini.js)
//   POST /api/weights  forwarded unchanged to the live weighting endpoint
// Keys come only from agent/.env. The deployed backend (https://prophetf.vercel.app) runs the
// same agent; this server is for local development.
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { loadAgentEnv } from "../agent/env.js";
import { AgentError, findStocks } from "../agent/gemini.js";

export const ALLOWED_ORIGINS = [
  "https://becomingwise.github.io",
  "http://localhost:8000",
  "http://127.0.0.1:8000"
];
export const WEIGHTS_URL = "https://prophetf.vercel.app/api/weights";
const MAX_BODY_BYTES = 16 * 1024;

function corsHeaders(origin) {
  const headers = { Vary: "Origin" };
  if (ALLOWED_ORIGINS.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
    headers["Access-Control-Allow-Methods"] = "POST, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "Content-Type, X-Session-Id";
    headers["Access-Control-Max-Age"] = "86400";
  }
  return headers;
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    request.on("data", chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AgentError("invalid_request", "The request body is too large.", 413));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

/**
 * @param {{ findStocks?: Function, fetch?: typeof fetch }} [deps] Replaceable for tests.
 */
export function createApp({ findStocks: find = findStocks, fetch: fetchFn = globalThis.fetch } = {}) {
  return createServer(async (request, response) => {
    const cors = corsHeaders(request.headers.origin);
    const send = (status, body) => {
      response.writeHead(status, { ...cors, "Content-Type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(body));
    };
    const fail = (status, code, message) => send(status, { error: { code, message } });
    const path = new URL(request.url, "http://localhost").pathname;

    if (!["/api/stocks", "/api/weights"].includes(path)) return fail(404, "not_found", "Unknown route.");
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      return response.end();
    }
    if (request.method !== "POST") return fail(405, "method_not_allowed", "Use POST.");

    // The request is abandoned when the browser goes away.
    const gone = new AbortController();
    response.on("close", () => { if (!response.writableEnded) gone.abort(); });

    try {
      const raw = await readBody(request);

      if (path === "/api/weights") {
        const upstream = await fetchFn(WEIGHTS_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: raw,
          signal: gone.signal
        });
        response.writeHead(upstream.status, { ...cors, "Content-Type": "application/json; charset=utf-8" });
        return response.end(await upstream.text());
      }

      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return fail(400, "invalid_request", 'The body must be JSON: { "idea": string }.');
      }
      const sessionId = request.headers["x-session-id"];
      const result = await find(
        { idea: body?.idea },
        { signal: gone.signal, basket: body?.basket === true, ...(sessionId ? { sessionId } : {}) }
      );
      return send(200, result);
    } catch (error) {
      if (gone.signal.aborted) return response.destroy();
      if (error instanceof AgentError) return fail(error.status, error.code, error.message);
      console.error(error);
      return fail(502, "upstream_error", "The request failed. Please try again.");
    }
  });
}

// Started directly (not imported by a test): read agent/.env and listen.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!loadAgentEnv() || !process.env.GEMINI_API_KEY) {
    console.error("Copy agent/.env.example to agent/.env and add GEMINI_API_KEY first.");
    process.exit(1);
  }
  const port = Number(process.env.PORT ?? 8787);
  createApp().listen(port, "127.0.0.1", () => {
    console.log(`Stock agent listening on http://127.0.0.1:${port}  (POST /api/stocks, POST /api/weights)`);
  });
}
