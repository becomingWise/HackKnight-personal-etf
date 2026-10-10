// Manual check of the decision workflow against real Gemini, live Polymarket and Tiger:
//   pnpm try:findstocks "AI chips and Taiwan risk"            the whole workflow (2 to 3 Gemini calls, lite model)
//   pnpm try:findstocks --packet "AI chips and Taiwan risk"   analyst and gate only (1 lite call for the search plan)
import { createPlanner } from "../src/lib/analyst/plan";
import { db } from "../src/lib/db/client";
import { gate } from "../src/lib/pipeline/gate";
import { defaultStocksDeps } from "../src/lib/pipeline/handler";
import { analystMode, defaultAnalysts, runAnalyst, runPipeline } from "../src/lib/pipeline/run";

const args = process.argv.slice(2);
const packetOnly = args.includes("--packet");
const idea = args.filter((a) => a !== "--packet").join(" ") || "AI chips and Taiwan risk";

const analysts = defaultAnalysts({
  search: defaultStocksDeps.search,
  pastOdds: defaultStocksDeps.pastOdds,
  plan: createPlanner({ generate: defaultStocksDeps.generate, cache: defaultStocksDeps.cache }),
});
const log = (e: string, d?: Record<string, unknown>) => console.log(e, JSON.stringify(d));
const started = Date.now();

if (packetOnly) {
  const { packet, step } = await runAnalyst(idea, { analysts, mode: analystMode(), log });
  console.log(JSON.stringify(packet, null, 2));
  console.log(`analyst: ${step.summary} (${step.ms} ms)`);
  console.log(`gate: ${gate(packet).summary}`);
} else {
  const result = await runPipeline(idea, {
    generate: defaultStocksDeps.generate,
    analysts,
    mode: analystMode(),
    checkerLlm: process.env.CHECKER_LLM === "true",
    log,
  });
  console.log(JSON.stringify(result.ok ? result.response : result, null, 2));
  const trace = result.ok ? (result.response.trace ?? []) : result.trace;
  for (const t of trace) console.log(`${t.step}: ${t.status}, ${t.summary} (${t.ms} ms)`);
  if (result.ok)
    console.log(`source ${result.response.source}, ${result.geminiCalls} Gemini calls`);
}
console.log(`total ${Date.now() - started} ms`);
await db().end({ timeout: 5 });
