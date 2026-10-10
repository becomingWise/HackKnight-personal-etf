// POST /api/decide — stages b to d of the decision workflow for a given packet:
// idea + evidence packet → gate → decider → checker. Contract: docs/API.md section 1c.
import { createDecideHandler } from "@/lib/pipeline/handler";

export const maxDuration = 30;

const handler = createDecideHandler();

export const POST = handler.POST;
export const OPTIONS = handler.OPTIONS;
