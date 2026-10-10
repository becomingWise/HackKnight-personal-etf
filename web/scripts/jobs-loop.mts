// Local stand-in for cron-job.org: calls the tick job once a minute.
//   pnpm jobs:loop                       against http://localhost:3000 (run `pnpm dev` too)
//   pnpm jobs:loop https://prophetf.vercel.app
// Reads CRON_SECRET from .env.local.
const base = (process.argv[2] ?? "http://localhost:3000").replace(/\/+$/, "");
const secret = process.env.CRON_SECRET;
if (!secret) {
  console.error("CRON_SECRET is not set (expected in .env.local).");
  process.exit(1);
}

async function tick() {
  const started = Date.now();
  try {
    const res = await fetch(`${base}/api/jobs/tick`, {
      method: "POST",
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(55_000),
    });
    const body = await res.text();
    console.log(`${new Date().toISOString()}  ${res.status}  ${body.slice(0, 200)}`);
  } catch (err) {
    console.log(
      `${new Date().toISOString()}  failed after ${Date.now() - started} ms: ${String(err)}`,
    );
  }
}

console.log(`Ticking ${base}/api/jobs/tick every 60 s. Ctrl+C to stop.`);
await tick();
setInterval(tick, 60_000);
