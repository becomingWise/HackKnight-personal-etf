// POST /api/findstock — alias of POST /api/stocks.
import { createStocksHandler } from "@/lib/stocks/handler";

export const maxDuration = 30;

const handler = createStocksHandler();

export const POST = handler.POST;
export const OPTIONS = handler.OPTIONS;
