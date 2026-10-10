// POST /api/baskets/{id}/narrate — audio briefing of a saved basket (ElevenLabs).
import { createNarrateHandlers } from "@/lib/narrate/handler";

export const maxDuration = 60;

const handlers = createNarrateHandlers();

export async function POST(request: Request, ctx: RouteContext<"/api/baskets/[id]/narrate">) {
  const { id } = await ctx.params;
  return handlers.narrate(request, id);
}

export const OPTIONS = handlers.options;
