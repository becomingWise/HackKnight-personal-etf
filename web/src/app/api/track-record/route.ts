// GET /api/track-record — how often each voting agent was right. Contract: docs/API.md section 1f.
import { connection } from "next/server";
import { createTrackRecordHandler } from "@/lib/track/record";

const handler = createTrackRecordHandler();

export async function GET(request: Request) {
  await connection();
  return handler.GET(request);
}

export const OPTIONS = handler.OPTIONS;
