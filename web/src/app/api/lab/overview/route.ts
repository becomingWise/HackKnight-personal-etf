// GET /api/lab/overview — Shaun's paper-trading Lab, read-only. Contract: docs/API.md section 1g.
import { connection } from "next/server";
import { labHandlers } from "@/lib/lab/handler";

export async function GET(request: Request) {
  await connection();
  return labHandlers.overview(request);
}

export const OPTIONS = labHandlers.OPTIONS;
