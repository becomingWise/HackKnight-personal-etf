// The track record's daily job, run on Lucas's machine (prices come from a local Python):
//   pnpm track:daily
// 1. refreshes the closes of the last 14 days (the same loader as `pnpm closes:load`);
// 2. scores every panel decision that is a week old and has its closes (SQL).
// Safe to run any number of times. To score without loading prices: pnpm track:daily --score-only
import { spawnSync } from "node:child_process";
import { db } from "../src/lib/db/client";
import { scoreDueDecisions } from "../src/lib/track/repo";

if (!process.argv.includes("--score-only")) {
  const from = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const tsx = process.platform === "win32" ? "tsx.cmd" : "tsx";
  const loaded = spawnSync(
    `node_modules/.bin/${tsx}`,
    ["--env-file-if-exists=.env.local", "scripts/load-closes.mts", from],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  if (loaded.status !== 0) {
    console.error("track:daily: the closes could not be refreshed; nothing was scored.");
    process.exit(1);
  }
}

const scored = await scoreDueDecisions();
const [open] = await db()<{ pending: number; next: string | null }[]>`
  select count(*)::int as pending, min(day + 7)::text as next
  from panel_decisions where scored_at is null`;
console.log(
  `track:daily: ${scored} decisions scored; ${open.pending} still waiting` +
    (open.next ? ` (the next one is due once the close of ${open.next} is loaded)` : ""),
);
await db().end();
