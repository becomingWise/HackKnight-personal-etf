// GET /api/audio/{id} — the MP3 briefing of basket {id}, stored in Tiger.
import { createNarrateHandlers } from "@/lib/narrate/handler";

const handlers = createNarrateHandlers();

export async function GET(request: Request, ctx: RouteContext<"/api/audio/[id]">) {
  const { id } = await ctx.params;
  return handlers.audio(request, id);
}

export const OPTIONS = handlers.options;
