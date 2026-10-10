// Live proof of the Gemini usage for GET /api/built-with.
import { db } from "../db/client";
import { demoStatus } from "../demo/warm";

export async function geminiProof() {
  const rows = await db()<{ kind: string; live: number; latest: Date | null }[]>`
    select kind, count(*) filter (where expires_at > now())::int as live, max(created_at) as latest
    from api_cache where kind in ('stocks', 'letter') group by 1`;
  const of = (kind: string) => rows.find((r) => r.kind === kind);
  const demo = await demoStatus();
  return {
    cachedStockAnswers: of("stocks")?.live ?? 0,
    lastStockAnswerAt: of("stocks")?.latest?.toISOString() ?? null,
    lettersWritten: of("letter")?.live ?? 0,
    lastLetterAt: of("letter")?.latest?.toISOString() ?? null,
    demoIdeasCached: demo.filter((d) => d.cached).length,
    demoIdeas: demo.length,
  };
}
