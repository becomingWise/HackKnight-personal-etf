// Manual check of the manager's note against real Gemini:
//   pnpm try:letter <basketId> [main|lite]
import { tigerBasketStore } from "../src/lib/baskets/store";
import { db } from "../src/lib/db/client";
import { writeLetter } from "../src/lib/letter/letter";
import { geminiGenerateJson } from "../src/lib/sponsors/gemini";

const [id, prefer] = process.argv.slice(2);
const stored = id ? await tigerBasketStore.get(id) : null;
if (!stored) {
  console.error("Usage: pnpm try:letter <basketId> [main|lite]  (basket not found)");
} else {
  const started = Date.now();
  const result = await writeLetter(
    { ...stored, url: "" },
    {
      generate: (args) =>
        geminiGenerateJson({
          ...args,
          prefer: prefer === "main" || prefer === "lite" ? prefer : args.prefer,
        }),
      log: (event, detail) => console.log(event, JSON.stringify(detail)),
    },
  );
  console.log(`${result.source} in ${Date.now() - started} ms:\n${result.letter}`);
}
await db().end({ timeout: 5 });
