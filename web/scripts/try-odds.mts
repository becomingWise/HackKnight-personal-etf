// Exercises the odds-history SQL against the real Tiger database and live Polymarket:
//   pnpm try:odds [marketId]
import { db } from "../src/lib/db/client";
import { tigerProof } from "../src/lib/builtwith/tiger";
import { oddsSeries, runTick } from "../src/lib/odds/service";

const id = process.argv[2] ?? "1633611";

for (const range of ["1d", "7d", "30d"] as const) {
  const started = Date.now();
  const result = await oddsSeries([id], range);
  const m = result.markets[0];
  console.log(
    `${range}: ${m ? `${m.points.length} points, current ${m.current}, change ${m.change}, "${m.question}"` : "market not found"}` +
      ` | query ${result.queryMs} ms, total ${Date.now() - started} ms`,
  );
}

console.log("tick:", JSON.stringify(await runTick()));
console.log("tick again (same minute):", JSON.stringify(await runTick()));

const proof = await tigerProof();
console.log(
  JSON.stringify(
    {
      rows: proof.rows,
      hypertable: proof.hypertable,
      jobs: proof.jobs,
      latency: proof.queryLatencyMs,
      bySource: proof.ticksBySource,
    },
    null,
    1,
  ),
);
await db().end({ timeout: 5 });
