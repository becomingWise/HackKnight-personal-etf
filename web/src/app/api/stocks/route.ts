// POST /api/stocks — the team's findStocks port. Contract: docs/API.md section 1.
import { createStocksHandler } from "@/lib/stocks/handler";

export const maxDuration = 30;

const handler = createStocksHandler();

export const POST = handler.POST;
export const OPTIONS = handler.OPTIONS;
