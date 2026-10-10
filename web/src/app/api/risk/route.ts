// POST /api/risk — event risk of a basket: its move if each linked Polymarket event happens or
// doesn't. Contract: docs/API.md section 2b.
import { createRiskHandler } from "@/lib/risk/handler";

export const maxDuration = 30;

const handler = createRiskHandler();

export const POST = handler.POST;
export const OPTIONS = handler.OPTIONS;
