// GET /b/{id} — the share URL of a basket. Returns the basket JSON for now; the frontend
// teammate will replace this with a page (then move this JSON to /api/baskets/{id} only).
import { createBasketHandlers } from "@/lib/baskets/handler";

const handlers = createBasketHandlers();

export async function GET(request: Request, ctx: RouteContext<"/b/[id]">) {
  const { id } = await ctx.params;
  return handlers.get(request, id);
}

export const OPTIONS = handlers.options;
