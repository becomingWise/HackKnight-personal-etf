// GET /api/baskets/{id} — load a saved basket. Contract: docs/API.md section 3.
import { createBasketHandlers } from "@/lib/baskets/handler";

const handlers = createBasketHandlers();

export async function GET(request: Request, ctx: RouteContext<"/api/baskets/[id]">) {
  const { id } = await ctx.params;
  return handlers.get(request, id);
}

export const OPTIONS = handlers.options;
