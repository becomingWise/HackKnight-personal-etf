// POST /api/votes — five AI voters on a basket from /api/stocks. Contract: docs/API.md section 1d.
import { createVotesHandler } from "@/lib/votes/handler";

export const maxDuration = 30;

const handler = createVotesHandler();

export const POST = handler.POST;
export const OPTIONS = handler.OPTIONS;
