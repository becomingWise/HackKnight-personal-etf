// /api/jobs/tick — every-minute odds refresh for markets cited by saved baskets.
// Requires `Authorization: Bearer <CRON_SECRET>`. Idempotent within a minute.
import { createOddsHandlers } from "@/lib/odds/handler";

export const maxDuration = 60;

const handlers = createOddsHandlers();

export const POST = handlers.tick;
export const GET = handlers.tick;
