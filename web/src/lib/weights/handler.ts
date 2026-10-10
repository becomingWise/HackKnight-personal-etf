// HTTP layer for POST /api/weights (the team's adjustWeights port).
import { cacheHeaders, tigerApiCache, weightsCacheKey, type ApiCache } from "../cache/apiCache";
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { json } from "../http/respond";
import {
  WeightsInputError,
  adjustWeights,
  weightsRequestSchema,
  type WeightsResponse,
} from "./adjustWeights";
import type { Signal } from "./engine";
import { liveSignals } from "./signals";

export const WEIGHTS_PER_IP_PER_MINUTE = 60;

export type WeightsDeps = {
  signals: () => Promise<Signal[]>;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  now?: () => Date;
  /** Shared response cache; omitted in tests that do not exercise caching. */
  cache?: ApiCache;
};

export const defaultWeightsDeps: WeightsDeps = {
  signals: liveSignals,
  rateLimit: hit,
  cache: tigerApiCache,
};

export function createWeightsHandler(deps: WeightsDeps = defaultWeightsDeps) {
  // `detail` is what the Python (FastAPI) service returns; `error` is this API's common shape.
  const fail = (request: Request, status: number, code: string, message: string, extra = {}) =>
    json(request, status, { detail: message, error: { code, message } }, extra);

  async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return fail(request, 422, "invalid_request", "The request body must be JSON.");
    }
    const parsed = weightsRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return fail(
        request,
        422,
        "invalid_request",
        `${where}${issue?.message ?? "Invalid request."}`,
      );
    }

    const rate = await deps.rateLimit([
      {
        bucket: `weights:ip:${ipKey(clientIp(request))}`,
        windowSeconds: 60,
        max: WEIGHTS_PER_IP_PER_MINUTE,
      },
    ]);
    if (!rate.allowed) {
      return fail(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
        "Retry-After": String(rate.retryAfterSeconds),
      });
    }

    const key = weightsCacheKey(parsed.data.holdings);
    const hitEntry = await deps.cache?.get<WeightsResponse>("weights", key);
    if (hitEntry) {
      return json(
        request,
        200,
        { ...hitEntry.value, cached: true, cachedAt: hitEntry.createdAt.toISOString() },
        cacheHeaders(hitEntry),
      );
    }

    try {
      const result = adjustWeights(parsed.data, await deps.signals(), deps.now?.());
      await deps.cache?.set("weights", key, result);
      return json(request, 200, { ...result, cached: false, cachedAt: null }, cacheHeaders(null));
    } catch (err) {
      if (err instanceof WeightsInputError) {
        return fail(request, 422, "invalid_request", err.message);
      }
      console.log(
        JSON.stringify({ at: "weights", event: "error", message: String(err).slice(0, 200) }),
      );
      return fail(
        request,
        502,
        "upstream_error",
        "The weighting service failed. Please try again.",
      );
    }
  }

  return { POST, OPTIONS: (request: Request) => preflight(request) };
}
