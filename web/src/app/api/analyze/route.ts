// POST /api/analyze — stage a of the decision workflow on its own: idea → evidence packet.
// Contract: docs/API.md section 1b.
import { createAnalyzeHandler } from "@/lib/pipeline/handler";

export const maxDuration = 30;

const handler = createAnalyzeHandler();

export const POST = handler.POST;
export const OPTIONS = handler.OPTIONS;
