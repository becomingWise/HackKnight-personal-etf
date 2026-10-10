// POST /api/baskets/{id}/letter — the "manager's note" for a saved basket, written by Gemini.
import { createLetterHandler } from "@/lib/letter/handler";

export const maxDuration = 30;

const handler = createLetterHandler();

export async function POST(request: Request, ctx: RouteContext<"/api/baskets/[id]/letter">) {
  const { id } = await ctx.params;
  return handler.POST(request, id);
}

export const OPTIONS = handler.OPTIONS;
