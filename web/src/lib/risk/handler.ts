// HTTP layer for POST /api/risk. Reuses the weights service's live signals (60 s cache).
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { error, json } from "../http/respond";
import type { Signal } from "../weights/engine";
import { liveSignals } from "../weights/signals";
import { RiskInputError, eventRisk, riskRequestSchema } from "./risk";

export const RISK_PER_IP_PER_MINUTE = 60;

export type RiskDeps = {
  signals: () => Promise<Signal[]>;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  now?: () => Date;
};

export const defaultRiskDeps: RiskDeps = { signals: liveSignals, rateLimit: hit };

export function createRiskHandler(deps: RiskDeps = defaultRiskDeps) {
  async function POST(request: Request): Promise<Response> {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return error(request, 422, "invalid_request", "The request body must be JSON.");
    }
    const parsed = riskRequestSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return error(
        request,
        422,
        "invalid_request",
        `${where}${issue?.message ?? "Invalid request."}`,
      );
    }

    const rate = await deps.rateLimit([
      {
        bucket: `risk:ip:${ipKey(clientIp(request))}`,
        windowSeconds: 60,
        max: RISK_PER_IP_PER_MINUTE,
      },
    ]);
    if (!rate.allowed) {
      return error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
        "Retry-After": String(rate.retryAfterSeconds),
      });
    }

    let signals: Signal[];
    try {
      signals = await deps.signals();
    } catch (err) {
      console.log(
        JSON.stringify({ at: "risk", event: "error", message: String(err).slice(0, 200) }),
      );
      return error(
        request,
        502,
        "upstream_error",
        "The Polymarket lookup failed. Please try again.",
      );
    }
    try {
      return json(request, 200, eventRisk(parsed.data, signals, deps.now?.()));
    } catch (err) {
      if (err instanceof RiskInputError) return error(request, 422, "invalid_request", err.message);
      throw err;
    }
  }

  return { POST, OPTIONS: (request: Request) => preflight(request) };
}
