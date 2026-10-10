// HTTP layer for saved baskets: POST /api/baskets, GET /api/baskets/{id}, GET /b/{id}.
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { baseUrl, error, json } from "../http/respond";
import { recordObservations } from "../odds/service";
import { liveSignals } from "../weights/signals";
import { BasketInputError, buildBasket, saveBasketSchema, type Basket } from "./schema";
import { BASKET_ID_PATTERN, tigerBasketStore, type BasketStore } from "./store";

export const SAVES_PER_IP_PER_MINUTE = 20;
export const SAVES_PER_IP_PER_DAY = 300;
const MAX_BODY_BYTES = 64 * 1024;

export type BasketDeps = {
  store: BasketStore;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  /** Maps a weights evidence item to its Polymarket market id, when known. */
  marketIds: () => Promise<(evidence: { title: string; url: string }) => string | null>;
  /** Called after a save with the basket's cited markets (step 3 hooks odds tracking in here). */
  onSaved?: (basket: Basket) => Promise<void>;
};

/** Evidence from /api/weights carries no market id; the live signal list knows it. */
async function signalMarketIds() {
  const signals = await liveSignals().catch(() => []);
  const byQuestion = new Map(
    signals.flatMap((s) => (s.marketId && s.question ? [[s.question, s.marketId] as const] : [])),
  );
  return (evidence: { title: string }) => byQuestion.get(evidence.title) ?? null;
}

const defaultDeps: BasketDeps = {
  store: tigerBasketStore,
  rateLimit: hit,
  marketIds: signalMarketIds,
  // The odds at creation become the first points of each cited market's history.
  onSaved: async (basket) => {
    await recordObservations(
      basket.markets.flatMap((m) =>
        m.id
          ? [
              {
                id: m.id,
                question: m.title,
                url: m.url,
                probability: m.probability,
                observedAt: Number.isFinite(Date.parse(m.observedAt))
                  ? new Date(m.observedAt)
                  : undefined,
              },
            ]
          : [],
      ),
      "basket",
    );
  },
};

export const shareUrl = (request: Request, id: string) => `${baseUrl(request)}/b/${id}`;

export function createBasketHandlers(deps: BasketDeps = defaultDeps) {
  async function save(request: Request): Promise<Response> {
    let body: unknown;
    try {
      const raw = await request.text();
      if (raw.length > MAX_BODY_BYTES) {
        return error(request, 413, "too_large", "The basket is too large to save.");
      }
      body = JSON.parse(raw);
    } catch {
      return error(request, 400, "invalid_request", "The request body must be JSON.");
    }
    const parsed = saveBasketSchema.safeParse(body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const where = issue?.path.length ? `${issue.path.join(".")}: ` : "";
      return error(
        request,
        400,
        "invalid_request",
        `${where}${issue?.message ?? "Invalid basket."}`,
      );
    }

    const ip = ipKey(clientIp(request));
    const rate = await deps.rateLimit([
      { bucket: `baskets:ip:${ip}`, windowSeconds: 60, max: SAVES_PER_IP_PER_MINUTE },
      { bucket: `baskets:ipday:${ip}`, windowSeconds: 86_400, max: SAVES_PER_IP_PER_DAY },
    ]);
    if (!rate.allowed) {
      return error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
        "Retry-After": String(rate.retryAfterSeconds),
      });
    }

    try {
      const built = buildBasket(parsed.data, await deps.marketIds());
      const { id, createdAt } = await deps.store.insert(built, ip);
      const basket: Basket = { id, url: shareUrl(request, id), createdAt, ...built };
      // Tracking is best effort: the basket is saved either way.
      await deps.onSaved?.(basket).catch(() => {});
      return json(request, 201, basket, { Location: `/api/baskets/${id}` });
    } catch (err) {
      if (err instanceof BasketInputError) {
        return error(request, 400, "invalid_request", err.message);
      }
      console.log(
        JSON.stringify({ at: "baskets", event: "error", message: String(err).slice(0, 200) }),
      );
      return error(
        request,
        503,
        "storage_error",
        "The basket could not be saved. Please try again.",
      );
    }
  }

  async function get(request: Request, id: string): Promise<Response> {
    if (!BASKET_ID_PATTERN.test(id)) {
      return error(request, 404, "not_found", "No basket with this id.");
    }
    try {
      const stored = await deps.store.get(id);
      if (!stored) return error(request, 404, "not_found", "No basket with this id.");
      const basket: Basket = { ...stored, url: shareUrl(request, id) };
      // A saved basket never changes, so it can be cached briefly.
      return json(request, 200, basket, { "Cache-Control": "public, max-age=60" });
    } catch (err) {
      console.log(
        JSON.stringify({ at: "baskets", event: "error", message: String(err).slice(0, 200) }),
      );
      return error(
        request,
        503,
        "storage_error",
        "The basket could not be loaded. Please try again.",
      );
    }
  }

  return { save, get, options: (request: Request) => preflight(request) };
}
