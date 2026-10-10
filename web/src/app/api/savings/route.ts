// GET /api/savings — what reusing answers saved today. Contract: docs/API.md section 1e.
import { connection } from "next/server";
import { createSavingsHandler } from "@/lib/savings/handler";

const handler = createSavingsHandler();

export async function GET(request: Request) {
  await connection();
  return handler.GET(request);
}

export const OPTIONS = handler.OPTIONS;
