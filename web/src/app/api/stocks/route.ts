// POST /api/stocks — the team's findStocks port.
// Answered by the stock agent in /agent (see src/lib/agentApi/handler.ts). Contract: docs/API.md section 1.
import { createAgentStocksHandler } from "@/lib/agentApi/handler";

export const maxDuration = 30;

const handler = createAgentStocksHandler();

export const POST = handler.POST;
export const OPTIONS = handler.OPTIONS;
