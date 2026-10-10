// POST /api/lab/stocks — the Lab's 7 to 10 company shortlist, from the live stock agent.
// Contract: docs/API.md section 1g.
import { labHandlers } from "@/lib/lab/handler";

export const maxDuration = 30;

export const POST = labHandlers.stocks;
export const OPTIONS = labHandlers.OPTIONS;
