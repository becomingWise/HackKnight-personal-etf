// HTTP layer for odds history: market history, basket odds, and the tick job.
import { timingSafeEqual } from "node:crypto";
import { tigerBasketStore, BASKET_ID_PATTERN, type BasketStore } from "../baskets/store";
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { error, json } from "../http/respond";
import { defaultOddsDeps, oddsSeries, parseRange, runTick, type OddsDeps } from "./service";

export const HISTORY_PER_IP_PER_MINUTE = 120;

export type OddsHandlerDeps = {
  odds: OddsDeps;
  baskets: BasketStore;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  cronSecret: () => string | undefined;
};

const defaults: OddsHandlerDeps = {
  odds: defaultOddsDeps,
  baskets: tigerBasketStore,
  rateLimit: hit,
  cronSecret: () => process.env.CRON_SECRET,
};

/** True when the request carries `Authorization: Bearer <CRON_SECRET>`. */
export function isCronAuthorized(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  const expected = Buffer.from(`Bearer ${secret}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function createOddsHandlers(deps: OddsHandlerDeps = defaults) {
  const limited = async (request: Request) => {
    const rate = await deps.rateLimit([
      {
        bucket: `odds:ip:${ipKey(clientIp(request))}`,
        windowSeconds: 60,
        max: HISTORY_PER_IP_PER_MINUTE,
      },
    ]);
    return rate.allowed
      ? null
      : error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
          "Retry-After": String(rate.retryAfterSeconds),
        });
  };

  const range = (request: Request) => parseRange(new URL(request.url).searchParams.get("range"));
  const badRange = (request: Request) =>
    error(request, 400, "invalid_request", "range must be one of 1d, 7d, 30d.");
  const failed = (request: Request, err: unknown) => {
    console.log(JSON.stringify({ at: "odds", event: "error", message: String(err).slice(0, 200) }));
    return error(request, 503, "storage_error", "Odds history is unavailable. Please try again.");
  };

  /** GET /api/markets/{id}/history?range= */
  async function marketHistory(request: Request, id: string): Promise<Response> {
    const r = range(request);
    if (!r) return badRange(request);
    if (!/^\d{1,20}$/.test(id)) return error(request, 404, "not_found", "No market with this id.");
    const denied = await limited(request);
    if (denied) return denied;
    try {
      const result = await oddsSeries([id], r, deps.odds);
      const market = result.markets[0];
      if (!market) return error(request, 404, "not_found", "No market with this id.");
      const { id: marketId, question, url, endDate, closed, ...series } = market;
      return json(request, 200, {
        market: { id: marketId, question, url, endDate, closed },
        range: result.range,
        bucketSeconds: result.bucketSeconds,
        from: result.from,
        to: result.to,
        ...series,
        queryMs: result.queryMs,
      });
    } catch (err) {
      return failed(request, err);
    }
  }

  /** GET /api/baskets/{id}/odds?range= */
  async function basketOdds(request: Request, id: string): Promise<Response> {
    const r = range(request);
    if (!r) return badRange(request);
    if (!BASKET_ID_PATTERN.test(id)) {
      return error(request, 404, "not_found", "No basket with this id.");
    }
    const denied = await limited(request);
    if (denied) return denied;
    try {
      const basket = await deps.baskets.get(id);
      if (!basket) return error(request, 404, "not_found", "No basket with this id.");
      const cited = basket.markets.filter((m) => m.id !== null);
      const result = await oddsSeries(
        cited.map((m) => m.id!),
        r,
        deps.odds,
      );
      const byId = new Map(result.markets.map((m) => [m.id, m]));
      return json(request, 200, {
        id: basket.id,
        createdAt: basket.createdAt,
        range: result.range,
        bucketSeconds: result.bucketSeconds,
        from: result.from,
        to: result.to,
        markets: cited.map((m) => {
          const series = byId.get(m.id!);
          return {
            id: m.id,
            title: m.title,
            url: m.url,
            citedBy: m.citedBy,
            probabilityAtCreation: m.probability,
            current: series?.current ?? null,
            // Change since the basket was created, when current odds are known.
            changeSinceCreation:
              series?.current === null || series?.current === undefined
                ? null
                : Math.round((series.current - m.probability) * 10000) / 10000,
            closed: series?.closed ?? false,
            points: series?.points ?? [],
          };
        }),
        untracked: basket.markets.filter((m) => m.id === null).map((m) => m.title),
        queryMs: result.queryMs,
      });
    } catch (err) {
      return failed(request, err);
    }
  }

  /** POST or GET /api/jobs/tick with `Authorization: Bearer <CRON_SECRET>`. */
  async function tick(request: Request): Promise<Response> {
    if (!isCronAuthorized(request, deps.cronSecret())) {
      return error(request, 401, "unauthorized", "Missing or wrong bearer token.");
    }
    try {
      return json(request, 200, { ok: true, ...(await runTick(deps.odds)) });
    } catch (err) {
      console.log(
        JSON.stringify({ at: "tick", event: "error", message: String(err).slice(0, 200) }),
      );
      return error(request, 500, "tick_failed", "The tick job failed.");
    }
  }

  return { marketHistory, basketOdds, tick, options: (request: Request) => preflight(request) };
}
