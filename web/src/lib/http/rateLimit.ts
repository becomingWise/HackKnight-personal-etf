// Fixed-window rate limiting. Counters live in Tiger so they hold across Vercel instances;
// if the database is unreachable, a per-instance in-memory counter takes over.
import { createHash } from "node:crypto";
import { db } from "../db/client";

export type Limit = { bucket: string; windowSeconds: number; max: number };
export type RateResult = { allowed: boolean; retryAfterSeconds: number };

const memory = new Map<string, number>();

function windowStart(nowMs: number, windowSeconds: number): number {
  return Math.floor(nowMs / (windowSeconds * 1000)) * windowSeconds * 1000;
}

export function memoryHit(limit: Limit, nowMs = Date.now()): RateResult {
  const start = windowStart(nowMs, limit.windowSeconds);
  const key = `${limit.bucket}|${start}`;
  const count = (memory.get(key) ?? 0) + 1;
  memory.set(key, count);
  if (memory.size > 5000) {
    for (const k of memory.keys()) if (!k.endsWith(`|${start}`)) memory.delete(k);
  }
  return {
    allowed: count <= limit.max,
    retryAfterSeconds: Math.max(1, Math.ceil((start + limit.windowSeconds * 1000 - nowMs) / 1000)),
  };
}

async function dbHit(limit: Limit, nowMs: number): Promise<RateResult> {
  const start = windowStart(nowMs, limit.windowSeconds);
  const rows = await db()<{ count: number }[]>`
    insert into api_rate_limits (bucket, window_start, count)
    values (${limit.bucket}, ${new Date(start)}, 1)
    on conflict (bucket, window_start) do update set count = api_rate_limits.count + 1
    returning count`;
  return {
    allowed: rows[0].count <= limit.max,
    retryAfterSeconds: Math.max(1, Math.ceil((start + limit.windowSeconds * 1000 - nowMs) / 1000)),
  };
}

/** Counts one request against every limit. Denied when any limit is exceeded. */
export async function hit(limits: Limit[], nowMs = Date.now()): Promise<RateResult> {
  let results: RateResult[];
  try {
    results = await Promise.all(limits.map((l) => dbHit(l, nowMs)));
    // Occasional cleanup of old windows; failures here are irrelevant.
    if (Math.random() < 0.02) {
      void db()`delete from api_rate_limits where window_start < now() - interval '2 days'`.catch(
        () => {},
      );
    }
  } catch {
    results = limits.map((l) => memoryHit(l, nowMs));
  }
  const denied = results.filter((r) => !r.allowed);
  return denied.length
    ? { allowed: false, retryAfterSeconds: Math.max(...denied.map((r) => r.retryAfterSeconds)) }
    : { allowed: true, retryAfterSeconds: 0 };
}

/** Caller IP as reported by the platform proxy (Vercel sets x-forwarded-for). */
export function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || request.headers.get("x-real-ip")?.trim() || "unknown";
}

/** IPs are stored hashed, never raw. */
export function ipKey(ip: string): string {
  const salt = process.env.CRON_SECRET ?? "prophetf";
  return createHash("sha256").update(`${salt}:${ip}`).digest("hex").slice(0, 24);
}
