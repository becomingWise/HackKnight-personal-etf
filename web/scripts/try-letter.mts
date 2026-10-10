// Manual check of the manager's note against real Gemini:
//   pnpm try:letter <basketId>
// It uses the note's model chain, which starts with the small-quota Flash models: ask Lucas first.
import { tigerBasketStore } from "../src/lib/baskets/store";
import { db } from "../src/lib/db/client";
import { writeLetter } from "../src/lib/letter/letter";
import { geminiGenerateJson } from "../src/lib/sponsors/gemini";

const [id] = process.argv.slice(2);
const stored = id ? await tigerBasketStore.get(id) : null;
if (!stored) {
  console.error("Usage: pnpm try:letter <basketId>  (basket not found)");
} else {
  const started = Date.now();
  const result = await writeLetter(
    { ...stored, url: "" },
    {
      generate: geminiGenerateJson,
      log: (event, detail) => console.log(event, JSON.stringify(detail)),
    },
  );
  console.log(`${result.source} in ${Date.now() - started} ms:\n${result.letter}`);
}
await db().end({ timeout: 5 });
