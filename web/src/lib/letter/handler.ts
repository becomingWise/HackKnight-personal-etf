// HTTP layer for POST /api/baskets/{id}/letter.
import { BASKET_ID_PATTERN, tigerBasketStore, type BasketStore } from "../baskets/store";
import { cacheHeaders, tigerApiCache, type ApiCache } from "../cache/apiCache";
import { preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { baseUrl, error, json } from "../http/respond";
import { geminiGenerateJson } from "../sponsors/gemini";
import { wordCount, writeLetter, type LetterDeps, type LetterResult } from "./letter";

export const LETTERS_PER_IP_PER_MINUTE = 20;
export const UNCACHED_LETTERS_PER_DAY = 400;
// A saved basket never changes, so its letter is kept far longer than a stocks answer.
export const LETTER_TTL_SECONDS = 30 * 86_400;

export type LetterHandlerDeps = LetterDeps & {
  baskets: BasketStore;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  cache?: ApiCache;
};

const defaults: LetterHandlerDeps = {
  generate: geminiGenerateJson,
  baskets: tigerBasketStore,
  rateLimit: hit,
  cache: tigerApiCache,
  log: (event, detail) => console.log(JSON.stringify({ at: "letter", event, ...detail })),
};

// The version is part of the key: bump it when the letter's rules change.
const cacheKey = (basketId: string) => `v3:${basketId}`;

type Cached = LetterResult & { generatedAt: string };

export function createLetterHandler(deps: LetterHandlerDeps = defaults) {
  const tooMany = (request: Request, rate: RateResult) =>
    error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
      "Retry-After": String(rate.retryAfterSeconds),
    });

  async function POST(request: Request, id: string): Promise<Response> {
    if (!BASKET_ID_PATTERN.test(id)) {
      return error(request, 404, "not_found", "No basket with this id.");
    }
    const perIp = await deps.rateLimit([
      {
        bucket: `letter:ip:${ipKey(clientIp(request))}`,
        windowSeconds: 60,
        max: LETTERS_PER_IP_PER_MINUTE,
      },
    ]);
    if (!perIp.allowed) return tooMany(request, perIp);

    const body = (value: Cached, cached: boolean, cachedAt: string | null) => ({
      id,
      letter: value.letter,
      words: wordCount(value.letter),
      source: value.source,
      generatedAt: value.generatedAt,
      cached,
      cachedAt,
    });

    const key = cacheKey(id);
    const hitEntry = await deps.cache?.get<Cached>("letter", key);
    if (hitEntry) {
      return json(
        request,
        200,
        body(hitEntry.value, true, hitEntry.createdAt.toISOString()),
        cacheHeaders(hitEntry),
      );
    }

    let stored;
    try {
      stored = await deps.baskets.get(id);
    } catch {
      return error(
        request,
        503,
        "storage_error",
        "The basket could not be loaded. Please try again.",
      );
    }
    if (!stored) return error(request, 404, "not_found", "No basket with this id.");

    const global = await deps.rateLimit([
      { bucket: "letter:uncached", windowSeconds: 86_400, max: UNCACHED_LETTERS_PER_DAY },
    ]);
    if (!global.allowed) return tooMany(request, global);

    const result = await writeLetter(
      { ...stored, url: `${baseUrl(request)}/b/${id}` },
      deps,
      request.signal,
    );
    const value: Cached = { ...result, generatedAt: new Date().toISOString() };
    // Only AI letters are cached, so a template never sticks once Gemini is back.
    if (result.source === "gemini") await deps.cache?.set("letter", key, value, LETTER_TTL_SECONDS);
    return json(request, 200, body(value, false, null), cacheHeaders(null));
  }

  return { POST, OPTIONS: (request: Request) => preflight(request) };
}
