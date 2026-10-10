// /api/jobs/warm — keeps the demo ideas cached. Requires `Authorization: Bearer <CRON_SECRET>`.
//   POST /api/jobs/warm            refresh the demo idea that expires first (one Gemini request)
//   POST /api/jobs/warm?idea=0..3  refresh that demo idea
//   GET  /api/jobs/warm            cache status of the demo ideas, nothing refreshed
import { DEMO_IDEAS, demoStatus, stalestIdea, warmIdea } from "@/lib/demo/warm";
import { error, json } from "@/lib/http/respond";
import { isCronAuthorized } from "@/lib/odds/handler";

export const maxDuration = 60;

function unauthorized(request: Request) {
  return error(request, 401, "unauthorized", "Missing or wrong bearer token.");
}

export async function GET(request: Request) {
  if (!isCronAuthorized(request, process.env.CRON_SECRET)) return unauthorized(request);
  return json(request, 200, { ok: true, ideas: await demoStatus() });
}

export async function POST(request: Request) {
  if (!isCronAuthorized(request, process.env.CRON_SECRET)) return unauthorized(request);
  const param = new URL(request.url).searchParams.get("idea");
  let idea: string;
  if (param === null) {
    idea = await stalestIdea();
  } else {
    const index = Number(param);
    if (!Number.isInteger(index) || index < 0 || index >= DEMO_IDEAS.length) {
      return error(request, 400, "invalid_request", `idea must be 0 to ${DEMO_IDEAS.length - 1}.`);
    }
    idea = DEMO_IDEAS[index];
  }
  const report = await warmIdea(idea);
  return json(request, 200, {
    ok: report.result !== "failed",
    ...report,
    ideas: await demoStatus(),
  });
}
