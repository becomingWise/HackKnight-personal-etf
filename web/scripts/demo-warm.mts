// Pre-computes the demo ideas and keeps them cached on the deployed backend.
//
//   pnpm demo:warm            warm all 4 ideas once (about 1 minute), then exit
//   pnpm demo:warm --loop     warm all 4, then refresh one idea every 3 minutes until Ctrl+C
//   pnpm demo:warm --status   only show what is cached
//   pnpm demo:warm --loop http://localhost:3000     against a local server
//
// Reads CRON_SECRET from .env.local. Each refresh costs two Gemini requests, so the loop
// uses well under one request per minute of the free quota.
const args = process.argv.slice(2);
const base = (args.find((a) => a.startsWith("http")) ?? "https://prophetf.vercel.app").replace(
  /\/+$/,
  "",
);
const loop = args.includes("--loop");
const statusOnly = args.includes("--status");
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET is not set (expected in web/.env.local).");
  process.exit(1);
}

type Idea = { idea: string; cached: boolean; secondsLeft: number };
type Report = {
  result: string;
  idea: string;
  source: string | null;
  symbols: string[];
  weights: string | null;
  ms: number;
  ideas: Idea[];
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = () => new Date().toLocaleTimeString();

async function call(method: "GET" | "POST", query = ""): Promise<Report & { ok: boolean }> {
  const res = await fetch(`${base}/api/jobs/warm${query}`, {
    method,
    headers: { Authorization: `Bearer ${secret}` },
    signal: AbortSignal.timeout(58_000),
  });
  if (res.status === 401) throw new Error("401: CRON_SECRET does not match the server's.");
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function printStatus(ideas: Idea[]) {
  for (const i of ideas) {
    const left = i.cached
      ? `cached, ${Math.floor(i.secondsLeft / 60)} min ${i.secondsLeft % 60} s left`
      : "NOT CACHED";
    console.log(`    ${i.cached ? "✓" : "✗"} ${i.idea.padEnd(34)} ${left}`);
  }
}

async function warm(query: string) {
  try {
    const r = await call("POST", query);
    const what =
      r.result === "refreshed"
        ? `refreshed → ${r.symbols.join(", ")} (weights ${r.weights ?? "not cached"})`
        : r.result === "kept"
          ? `Gemini unavailable, kept the previous answer → ${r.symbols.join(", ")}`
          : `FAILED (${r.source ?? "no answer"}), nothing cached for this idea`;
    console.log(`${stamp()}  "${r.idea}"  ${what}  [${(r.ms / 1000).toFixed(1)} s]`);
    return r;
  } catch (err) {
    console.log(`${stamp()}  request failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

// Ends by returning rather than process.exit: exiting right after a fetch crashes Node on Windows.
async function main() {
  console.log(`Demo cache on ${base}`);
  if (statusOnly) {
    printStatus((await call("GET")).ideas);
    return;
  }

  // All four, spaced out so the burst stays inside Gemini's per-minute quota.
  let last: Report | null = null;
  for (let i = 0; i < 4; i++) {
    last = (await warm(`?idea=${i}`)) ?? last;
    if (i < 3) await sleep(12_000);
  }
  if (last) printStatus(last.ideas);

  if (!loop) {
    console.log("Done. Answers stay cached for 15 minutes; use --loop to keep them warm.");
    return;
  }

  console.log("Keeping warm: one refresh every 3 minutes (each idea every 12). Ctrl+C to stop.");
  for (;;) {
    await sleep(180_000);
    const r = await warm("");
    if (r) printStatus(r.ideas);
  }
}

await main();
