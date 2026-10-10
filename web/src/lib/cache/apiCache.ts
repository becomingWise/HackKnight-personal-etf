// Response cache in Tiger, shared by every server instance. All operations fail open:
// a database problem means "not cached", never a failed request.
import { createHash } from "node:crypto";
import { db } from "../db/client";

export const CACHE_TTL_SECONDS = 15 * 60;

export type CacheKind = "stocks" | "decide" | "plan" | "weights" | "letter";
export type CacheEntry<T> = { value: T; createdAt: Date; expiresAt: Date };

export type ApiCache = {
  get<T>(kind: CacheKind, key: string): Promise<CacheEntry<T> | null>;
  set(kind: CacheKind, key: string, value: unknown, ttlSeconds?: number): Promise<void>;
  /** Pushes an existing entry's expiry out from now. Returns false when there is none. */
  extend(kind: CacheKind, key: string, ttlSeconds?: number): Promise<boolean>;
  /** When the entry expires, or null when it is missing or already expired. */
  expiresAt(kind: CacheKind, key: string): Promise<Date | null>;
};

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

/**
 * Ideas that differ only in case, spacing, Unicode form or surrounding punctuation share an
 * entry: "  AI chips and Taiwan risk. " and "ai chips and taiwan risk" are the same request.
 */
export function normalizeIdea(idea: string): string {
  return idea
    .normalize("NFKC")
    .toLocaleLowerCase()
    .replace(/\s+/g, " ")
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, "");
}

// The version is part of the key: bump it when the response shape changes.
export const stocksCacheKey = (idea: string) => hash(`stocks:v3:${normalizeIdea(idea)}`);

/** The mock analyst's search plan for an idea. */
export const planCacheKey = (idea: string) => hash(`plan:v1:${normalizeIdea(idea)}`);

/** A decision depends on the idea and on every field of the packet it was made from. */
export const decideCacheKey = (idea: string, packet: unknown) =>
  hash(`decide:v1:${normalizeIdea(idea)}:${JSON.stringify(packet)}`);

/**
 * Weights depend only on the holdings (the idea is not used by the method). Symbols are kept
 * as sent because the response echoes them; order matters for the same reason.
 */
export const weightsCacheKey = (holdings: { symbol: string; weightPct: number }[]) =>
  hash(`weights:v1:${JSON.stringify(holdings.map((h) => [h.symbol, h.weightPct]))}`);

type Row = { response: unknown; created_at: Date; expires_at: Date };

export const tigerApiCache: ApiCache = {
  async get<T>(kind: CacheKind, key: string) {
    try {
      const rows = await db()<Row[]>`
        select response, created_at, expires_at from api_cache
        where kind = ${kind} and key = ${key} and expires_at > now()`;
      const row = rows[0];
      return row
        ? { value: row.response as T, createdAt: row.created_at, expiresAt: row.expires_at }
        : null;
    } catch {
      return null;
    }
  },

  async set(kind, key, value, ttlSeconds = CACHE_TTL_SECONDS) {
    try {
      const sql = db();
      await sql`
        insert into api_cache (kind, key, response, created_at, expires_at)
        values (${kind}, ${key}, ${sql.json(value as never)}, now(), now() + ${ttlSeconds} * interval '1 second')
        on conflict (kind, key) do update set
          response = excluded.response,
          created_at = excluded.created_at,
          expires_at = excluded.expires_at`;
      // Occasional cleanup; expired rows are never served either way.
      if (Math.random() < 0.02) {
        void sql`delete from api_cache where expires_at < now() - interval '1 hour'`.catch(
          () => {},
        );
      }
    } catch {
      // Not cached; the request itself already succeeded.
    }
  },

  async extend(kind, key, ttlSeconds = CACHE_TTL_SECONDS) {
    try {
      const result = await db()`
        update api_cache set expires_at = now() + ${ttlSeconds} * interval '1 second'
        where kind = ${kind} and key = ${key}`;
      return result.count > 0;
    } catch {
      return false;
    }
  },

  async expiresAt(kind, key) {
    try {
      const rows = await db()<{ expires_at: Date }[]>`
        select expires_at from api_cache
        where kind = ${kind} and key = ${key} and expires_at > now()`;
      return rows[0]?.expires_at ?? null;
    } catch {
      return null;
    }
  },
};

/** In-memory implementation for tests and local experiments. */
export function memoryApiCache(now: () => number = Date.now): ApiCache {
  const rows = new Map<string, { value: unknown; createdAt: number; expiresAt: number }>();
  const live = (k: string) => {
    const row = rows.get(k);
    return row && row.expiresAt > now() ? row : null;
  };
  return {
    async get<T>(kind: CacheKind, key: string) {
      const row = live(`${kind}:${key}`);
      return row
        ? {
            value: structuredClone(row.value) as T,
            createdAt: new Date(row.createdAt),
            expiresAt: new Date(row.expiresAt),
          }
        : null;
    },
    async set(kind, key, value, ttlSeconds = CACHE_TTL_SECONDS) {
      rows.set(`${kind}:${key}`, {
        value: structuredClone(value),
        createdAt: now(),
        expiresAt: now() + ttlSeconds * 1000,
      });
    },
    async extend(kind, key, ttlSeconds = CACHE_TTL_SECONDS) {
      const row = rows.get(`${kind}:${key}`);
      if (!row) return false;
      row.expiresAt = now() + ttlSeconds * 1000;
      return true;
    },
    async expiresAt(kind, key) {
      const row = live(`${kind}:${key}`);
      return row ? new Date(row.expiresAt) : null;
    },
  };
}

/** Headers that tell a client whether the answer came from the cache. */
export function cacheHeaders(
  entry: { createdAt: Date } | null,
  now = Date.now(),
): Record<string, string> {
  return entry
    ? {
        "X-Cache": "HIT",
        "X-Cache-Age": String(Math.max(0, Math.round((now - entry.createdAt.getTime()) / 1000))),
      }
    : { "X-Cache": "MISS" };
}
