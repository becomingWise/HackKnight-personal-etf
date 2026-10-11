// Warms the demo: runs each example idea of the Build page through the same calls the page makes
// (POST /api/stocks, then /api/votes, /api/weights and /api/risk), so that on stage the answers
// come from the cache.
//
//   pnpm demo:warm                          the four example ideas and the "car" question, once
//   pnpm demo:warm --loop                   again every 10 minutes until Ctrl+C
//   pnpm demo:warm http://localhost:3000    against a local server
//
// Cost: an idea that is already cached costs no Gemini call (the line says "reused"). A new one
// costs 2 Flash-Lite calls for the pick and 5 for the panel; the "car" question costs 1.
// How long an answer stays warm: up to 24 hours while the Polymarket odds it cites stay within
// 3 points; an answer that cites no market 15 minutes (the panel 30), and so does the question.
// Needs no secret: it only uses the public API, like a visitor.
import { EXAMPLE_IDEAS, equalWeights } from "../src/app/productView";

const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "https://prophetf.vercel.app").replace(
  /\/+$/,
  "",
);
const loop = args.includes("--loop");
/** The clarify step of the demo script (docs/DEMO.md). */
const QUESTION_IDEA = "car";
const LOOP_MINUTES = 10;
// Spaced out so a cold run stays inside Gemini's per-minute quota (15 requests per model).
const PAUSE_MS = 20_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString();

type Answer = { status: number; cache: string | null; ms: number; body: unknown };

async function call(path: string, body: unknown): Promise<Answer> {
  const started = Date.now();
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Session-Id": "demo-warm" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(58_000),
  });
  return {
    status: response.status,
    cache: response.headers.get("X-Cache"),
    ms: Date.now() - started,
    body: await response.json().catch(() => null),
  };
}

const how = (answer: Answer) =>
  answer.status !== 200
    ? `FAILED (${answer.status})`
    : answer.cache === "HIT"
      ? "reused"
      : answer.cache === "MISS"
        ? "new"
        : "ok";

/** Warms one idea. Returns true when a Gemini call was needed, so the next idea waits a little. */
async function warm(idea: string): Promise<boolean> {
  try {
    const picked = await call("/api/stocks", { idea });
    const error = (picked.body as { error?: { code?: string; message?: string } } | null)?.error;
    if (picked.status === 422 && error?.code === "needs_clarification") {
      const options = (picked.body as { error: { options?: string[] } }).error.options ?? [];
      console.log(`${stamp()}  "${idea}"  asks: ${error.message}  [${options.join(" | ")}]`);
      return true;
    }
    const stocks = (picked.body as { stocks?: { symbol: string; name: string }[] } | null)?.stocks;
    if (picked.status !== 200 || !stocks?.length) {
      console.log(`${stamp()}  "${idea}"  stocks FAILED (${picked.status} ${error?.code ?? ""})`);
      return true;
    }
    const holdings = equalWeights(stocks.map((stock) => stock.symbol));
    const [votes, weights] = await Promise.all([
      call("/api/votes", { idea, stocks }),
      call("/api/weights", { idea, holdings }),
    ]);
    const tilted = (weights.body as { holdings?: unknown } | null)?.holdings ?? holdings;
    const risk = await call("/api/risk", { holdings: tilted });
    console.log(
      `${stamp()}  "${idea}"  ${stocks.map((stock) => stock.symbol).join(", ")}` +
        `  stocks ${how(picked)}, votes ${how(votes)}, weights ${how(weights)}, risk ${how(risk)}` +
        `  [${((picked.ms + Math.max(votes.ms, weights.ms)) / 1000).toFixed(1)} s]`,
    );
    return picked.cache !== "HIT" || votes.cache !== "HIT";
  } catch (err) {
    console.log(
      `${stamp()}  "${idea}"  request failed: ${err instanceof Error ? err.message : err}`,
    );
    return true;
  }
}

async function round() {
  const ideas = [...EXAMPLE_IDEAS, QUESTION_IDEA];
  for (const [index, idea] of ideas.entries()) {
    const spent = await warm(idea);
    if (spent && index < ideas.length - 1) await sleep(PAUSE_MS);
  }
}

// Ends by returning rather than process.exit: exiting right after a fetch crashes Node on Windows.
async function main() {
  console.log(`Warming the demo on ${base}`);
  await round();
  if (!loop) {
    console.log('Done. "reused" = answered from the cache, no Gemini call. Use --loop on stage.');
    return;
  }
  console.log(`Keeping warm: every ${LOOP_MINUTES} minutes. Ctrl+C to stop.`);
  for (;;) {
    await sleep(LOOP_MINUTES * 60_000);
    await round();
  }
}

await main();
