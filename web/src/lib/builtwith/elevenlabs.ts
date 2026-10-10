// Live proof of the ElevenLabs usage for GET /api/built-with.
import { db } from "../db/client";
import { elevenLabsModel, MP3_BYTES_PER_SECOND } from "../sponsors/elevenlabs";

export async function elevenLabsProof(base: string) {
  const rows = await db()<
    {
      briefings: number;
      bytes: number;
      characters: number;
      latest: Date | null;
      latest_id: string | null;
    }[]
  >`
    select
      count(*)::int as briefings,
      coalesce(sum(octet_length(audio)), 0)::int as bytes,
      coalesce(sum(character_cost), 0)::int as characters,
      max(created_at) as latest,
      (select basket_id from briefings order by created_at desc limit 1) as latest_id
    from briefings`;
  const r = rows[0];
  return {
    model: elevenLabsModel(),
    usedFor: "POST /api/baskets/{id}/narrate: reads a basket's manager's note aloud",
    briefings: r.briefings,
    audioSeconds: Math.round(r.bytes / MP3_BYTES_PER_SECOND),
    audioStoredIn: "Tiger (bytea), served from /api/audio/{id}",
    charactersBilled: r.characters,
    lastBriefingAt: r.latest?.toISOString() ?? null,
    latestAudioUrl: r.latest_id ? `${base}/api/audio/${r.latest_id}` : null,
  };
}
