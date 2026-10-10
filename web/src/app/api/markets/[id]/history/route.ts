// GET /api/markets/{id}/history?range=1d|7d|30d — odds history of one Polymarket market.
import { createOddsHandlers } from "@/lib/odds/handler";

export const maxDuration = 30;

const handlers = createOddsHandlers();

export async function GET(request: Request, ctx: RouteContext<"/api/markets/[id]/history">) {
  const { id } = await ctx.params;
  return handlers.marketHistory(request, id);
}

export const OPTIONS = handlers.options;
