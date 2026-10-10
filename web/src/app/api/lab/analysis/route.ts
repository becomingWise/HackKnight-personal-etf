// POST /api/lab/analysis — Shaun's paper-trading Lab, read-only. Contract: docs/API.md section 1g.
import { labHandlers } from "@/lib/lab/handler";

export const POST = labHandlers.analysis;
export const OPTIONS = labHandlers.OPTIONS;
