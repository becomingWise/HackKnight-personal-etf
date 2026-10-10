// POST /api/weights — the team's adjustWeights port (TypeScript port of the Python service
// in /backend, which remains the reference). Contract: docs/API.md section 2.
import { createWeightsHandler } from "@/lib/weights/handler";

export const maxDuration = 30;

const handler = createWeightsHandler();

export const POST = handler.POST;
export const OPTIONS = handler.OPTIONS;
