// Audio briefings: POST /api/baskets/{id}/narrate and GET /api/audio/{id}.
// The script is the basket's manager's note; ElevenLabs reads it. Without ElevenLabs (flag
// off, keys missing, or the call failing) the answer still carries the script, with no audio.
import type { Basket } from "../baskets/schema";
import { BASKET_ID_PATTERN, tigerBasketStore, type BasketStore } from "../baskets/store";
import { tigerApiCache, type ApiCache } from "../cache/apiCache";
import { isLive } from "../flags";
import { corsHeaders, preflight } from "../http/cors";
import { clientIp, hit, ipKey, type Limit, type RateResult } from "../http/rateLimit";
import { baseUrl, error, json } from "../http/respond";
import { LETTER_TTL_SECONDS, letterCacheKey, type CachedLetter } from "../letter/handler";
import { wordCount, writeLetter, type LetterDeps } from "../letter/letter";
import { MP3_BYTES_PER_SECOND, synthesize, type Synthesize } from "../sponsors/elevenlabs";
import { geminiGenerateJson } from "../sponsors/gemini";
import { tigerBriefingStore, type BriefingMeta, type BriefingStore } from "./store";

export const NARRATIONS_PER_IP_PER_MINUTE = 10;
// Each new briefing is billed by ElevenLabs (about 85 characters of a 10,000 monthly allowance
// on this account, measured 2026-10-09); stored ones are free to replay.
export const NEW_NARRATIONS_PER_DAY = 30;

export type NarrateDeps = LetterDeps & {
  baskets: BasketStore;
  briefings: BriefingStore;
  synthesize: Synthesize;
  /** True when the ElevenLabs integration is switched on and configured. */
  live: () => boolean;
  rateLimit: (limits: Limit[]) => Promise<RateResult>;
  cache?: ApiCache;
};

const defaults: NarrateDeps = {
  generate: geminiGenerateJson,
  baskets: tigerBasketStore,
  briefings: tigerBriefingStore,
  synthesize,
  live: () => isLive("elevenlabs"),
  rateLimit: hit,
  cache: tigerApiCache,
  log: (event, detail) => console.log(JSON.stringify({ at: "narrate", event, ...detail })),
};

/**
 * What ElevenLabs reads aloud: a short intro and the manager's note, tidied for speech.
 * Tickers become company names (a voice spells "NVDA" letter by letter) and weights are
 * rounded to whole percentages, which keeps the briefing well under a minute.
 */
export function briefingScript(
  idea: string,
  letter: string,
  stocks: { symbol: string; name: string }[] = [],
): string {
  let spoken = letter.replace(/["“”]/g, "").replace(/\s+/g, " ").trim();
  for (const stock of stocks) {
    const symbol = stock.symbol.replace(/[^A-Za-z0-9]/g, "\\$&");
    spoken = spoken.replace(new RegExp(`\\b${symbol}\\b`, "g"), stock.name);
  }
  spoken = spoken.replace(/(\d+)[.,](\d+)\s*%/g, (_match, whole: string, frac: string) =>
    // Small odds keep one decimal: "3.6%" must not become "4%".
    Number(whole) < 10 ? `${whole}.${frac[0]}%` : `${Math.round(Number(`${whole}.${frac}`))}%`,
  );
  return `Here is the ProphETF briefing for your idea: ${idea.trim().replace(/[.!?]+$/, "")}. ${spoken}`;
}

export function createNarrateHandlers(deps: NarrateDeps = defaults) {
  const tooMany = (request: Request, rate: RateResult) =>
    error(request, 429, "rate_limited", "Too many requests. Please try again shortly.", {
      "Retry-After": String(rate.retryAfterSeconds),
    });

  const body = (
    request: Request,
    id: string,
    script: string,
    meta: BriefingMeta | null,
    cached: boolean,
    note?: string,
  ) => ({
    id,
    mode: meta ? ("live" as const) : ("mock" as const),
    script,
    words: wordCount(script),
    audioUrl: meta ? `${baseUrl(request)}/api/audio/${id}` : null,
    mime: meta?.mime ?? null,
    bytes: meta?.bytes ?? null,
    durationSeconds: meta ? Math.round((meta.bytes / MP3_BYTES_PER_SECOND) * 10) / 10 : null,
    model: meta?.model ?? null,
    generatedAt: meta?.createdAt ?? null,
    cached,
    ...(note ? { note } : {}),
  });

  /** The basket's letter from the cache, or a newly written one. */
  async function letterFor(basket: Basket, signal?: AbortSignal): Promise<string> {
    const key = letterCacheKey(basket.id);
    const hitEntry = await deps.cache?.get<CachedLetter>("letter", key);
    if (hitEntry) return hitEntry.value.letter;
    const result = await writeLetter(basket, deps, signal);
    if (result.source === "gemini") {
      const value: CachedLetter = { ...result, generatedAt: new Date().toISOString() };
      await deps.cache?.set("letter", key, value, LETTER_TTL_SECONDS);
    }
    return result.letter;
  }

  /** POST /api/baskets/{id}/narrate */
  async function narrate(request: Request, id: string): Promise<Response> {
    if (!BASKET_ID_PATTERN.test(id)) {
      return error(request, 404, "not_found", "No basket with this id.");
    }
    const perIp = await deps.rateLimit([
      {
        bucket: `narrate:ip:${ipKey(clientIp(request))}`,
        windowSeconds: 60,
        max: NARRATIONS_PER_IP_PER_MINUTE,
      },
    ]);
    if (!perIp.allowed) return tooMany(request, perIp);

    let stored;
    let existing: BriefingMeta | null;
    try {
      existing = await deps.briefings.meta(id);
      if (existing) return json(request, 200, body(request, id, existing.script, existing, true));
      stored = await deps.baskets.get(id);
    } catch {
      return error(
        request,
        503,
        "storage_error",
        "The briefing could not be loaded. Please try again.",
      );
    }
    if (!stored) return error(request, 404, "not_found", "No basket with this id.");

    const basket: Basket = { ...stored, url: `${baseUrl(request)}/b/${id}` };
    const script = briefingScript(
      basket.idea,
      await letterFor(basket, request.signal),
      basket.stocks,
    );

    if (!deps.live()) {
      return json(
        request,
        200,
        body(
          request,
          id,
          script,
          null,
          false,
          "Audio is switched off; the script can be read or spoken by the browser.",
        ),
      );
    }

    const budget = await deps.rateLimit([
      { bucket: "narrate:new", windowSeconds: 86_400, max: NEW_NARRATIONS_PER_DAY },
    ]);
    if (!budget.allowed) {
      return json(
        request,
        200,
        body(
          request,
          id,
          script,
          null,
          false,
          "Today's audio budget is used up; the script is still available.",
        ),
      );
    }

    try {
      const speech = await deps.synthesize(script, request.signal);
      const meta = await deps.briefings.put({ basketId: id, script, ...speech });
      return json(request, 200, body(request, id, script, meta, false));
    } catch (err) {
      // One failing sponsor API must not break the demo: answer with the script alone.
      deps.log?.("elevenlabs_error", {
        message: err instanceof Error ? err.message.slice(0, 120) : "unknown",
      });
      return json(
        request,
        200,
        body(
          request,
          id,
          script,
          null,
          false,
          "Audio could not be generated right now; the script is still available.",
        ),
      );
    }
  }

  /** GET /api/audio/{id} — the stored MP3, with byte-range support for media players. */
  async function audio(request: Request, id: string): Promise<Response> {
    if (!BASKET_ID_PATTERN.test(id)) {
      return error(request, 404, "not_found", "No audio with this id.");
    }
    let row;
    try {
      row = await deps.briefings.audio(id);
    } catch {
      return error(
        request,
        503,
        "storage_error",
        "The audio could not be loaded. Please try again.",
      );
    }
    if (!row) return error(request, 404, "not_found", "No audio with this id.");

    const total = row.audio.length;
    const headers: Record<string, string> = {
      ...corsHeaders(request),
      // Audio is public and safe to embed from any page.
      "Access-Control-Allow-Origin": "*",
      "Content-Type": row.mime,
      "Accept-Ranges": "bytes",
      "Cache-Control": "public, max-age=86400",
    };
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "");
    if (range && (range[1] || range[2])) {
      // "bytes=500-" from 500 to the end, "bytes=-500" the last 500 bytes.
      const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), total - 1) : total - 1;
      if (start >= total || start > end) {
        return new Response(null, {
          status: 416,
          headers: { ...headers, "Content-Range": `bytes */${total}` },
        });
      }
      return new Response(new Uint8Array(row.audio.subarray(start, end + 1)), {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
    return new Response(new Uint8Array(row.audio), {
      status: 200,
      headers: { ...headers, "Content-Length": String(total) },
    });
  }

  return { narrate, audio, options: (request: Request) => preflight(request) };
}
