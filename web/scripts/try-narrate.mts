// Manual check of the audio briefing against real ElevenLabs (spends about 700 characters
// the first time for a basket; later runs reuse the stored MP3):
//   pnpm try:narrate <basketId> [out.mp3]
// Forces the live path regardless of FEATURE_ELEVENLABS; needs the key and voice in .env.local.
import { writeFile } from "node:fs/promises";
import { db } from "../src/lib/db/client";
import { createNarrateHandlers } from "../src/lib/narrate/handler";
import { tigerBriefingStore } from "../src/lib/narrate/store";
import { tigerBasketStore } from "../src/lib/baskets/store";
import { tigerApiCache } from "../src/lib/cache/apiCache";
import { synthesize } from "../src/lib/sponsors/elevenlabs";
import { geminiGenerateJson } from "../src/lib/sponsors/gemini";

const [id, out] = process.argv.slice(2);
if (!id) {
  console.error("Usage: pnpm try:narrate <basketId> [out.mp3]");
} else {
  const handlers = createNarrateHandlers({
    generate: geminiGenerateJson,
    baskets: tigerBasketStore,
    briefings: tigerBriefingStore,
    synthesize,
    live: () => true,
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    cache: tigerApiCache,
    log: (event, detail) => console.log(event, JSON.stringify(detail)),
  });
  const started = Date.now();
  const res = await handlers.narrate(
    new Request(`http://localhost:3000/api/baskets/${id}/narrate`, { method: "POST" }),
    id,
  );
  const body = await res.json();
  console.log(`${res.status} in ${Date.now() - started} ms`);
  console.log(JSON.stringify(body, null, 2));
  if (body.mode === "live" && out) {
    const audio = await tigerBriefingStore.audio(id);
    if (audio) {
      await writeFile(out, audio.audio);
      console.log(`Saved ${audio.audio.length} bytes to ${out}`);
    }
  }
}
await db().end({ timeout: 5 });
