// GET /api/baskets/{id}/odds?range=1d|7d|30d — history of every market a basket cites.
import { createOddsHandlers } from "@/lib/odds/handler";

export const maxDuration = 30;

const handlers = createOddsHandlers();

export async function GET(request: Request, ctx: RouteContext<"/api/baskets/[id]/odds">) {
  const { id } = await ctx.params;
  return handlers.basketOdds(request, id);
}

export const OPTIONS = handlers.options;
