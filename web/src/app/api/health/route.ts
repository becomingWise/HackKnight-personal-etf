import { connection } from "next/server";
import { getHealth } from "@/lib/health";

export async function GET() {
  await connection();
  const health = await getHealth();
  return Response.json(health, {
    status: health.ok ? 200 : 503,
    headers: { "Cache-Control": "no-store" },
  });
}
