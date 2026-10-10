// Read-only Polymarket access for odds tracking: markets by id (Gamma) and price history
// (Data API v2). No auth, no trading endpoints.
import { z } from "zod";
import { gammaMarket, referencePrice, yesTokenId } from "./search";

const GAMMA = "https://gamma-api.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";
const HEADERS = {
  "User-Agent": "prophetf/0.1 (hackathon demo, read-only)",
  Accept: "application/json",
};

export type MarketSnapshot = {
  id: string;
  question: string;
  url: string | null;
  yesTokenId: string | null;
  endDate: string | null;
  closed: boolean;
  /** Reference price of Yes, or the payout once resolved; null when there is no real price. */
  probability: number | null;
};

const eventRef = z.looseObject({ slug: z.string() });

/** Turns one Gamma market object into a snapshot. Returns null when it is not a market. */
export function parseMarket(raw: unknown): MarketSnapshot | null {
  const parsed = gammaMarket.safeParse(raw);
  if (!parsed.success) return null;
  const m = parsed.data;
  const event = eventRef.safeParse((m.events as unknown[] | undefined)?.[0]);
  const closed =
    !!m.closed || m.resolutionStatus === "resolved" || m.umaResolutionStatus === "resolved";
  let probability = closed ? null : referencePrice(m);
  if (closed) {
    // A resolved market's price is its payout: outcomePrices is ["1","0"], ["0","1"] or 50/50.
    try {
      const payout = Number(JSON.parse(m.outcomePrices ?? "[]")[0]);
      probability = Number.isFinite(payout) && payout >= 0 && payout <= 1 ? payout : null;
    } catch {
      probability = null;
    }
  }
  return {
    id: m.id,
    question: m.question.trim(),
    url: event.success ? `https://polymarket.com/event/${event.data.slug}` : null,
    yesTokenId: yesTokenId(m),
    endDate: m.endDate ?? null,
    closed,
    probability: probability === null ? null : Math.round(probability * 10000) / 10000,
  };
}

async function getJson(url: URL, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(8000);
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    });
    // Back off once or twice on rate limiting, then give up.
    if (res.status === 429 && attempt < 2) {
      await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
      continue;
    }
    if (!res.ok) throw new Error(`Polymarket ${url.pathname} answered ${res.status}`);
    return res.json();
  }
}

export type FetchMarkets = (ids: string[], signal?: AbortSignal) => Promise<MarketSnapshot[]>;

/** Current state of the given markets, in batches of 50. Unknown ids are simply absent. */
export const fetchMarketsByIds: FetchMarkets = async (ids, signal) => {
  const unique = [...new Set(ids)].filter((id) => /^\d{1,20}$/.test(id));
  const out: MarketSnapshot[] = [];
  for (let i = 0; i < unique.length; i += 50) {
    const url = new URL(`${GAMMA}/markets`);
    for (const id of unique.slice(i, i + 50)) url.searchParams.append("id", id);
    url.searchParams.set("limit", "50");
    const payload = await getJson(url, signal);
    for (const raw of Array.isArray(payload) ? payload : []) {
      const market = parseMarket(raw);
      if (market) out.push(market);
    }
  }
  return out;
};

export type PricePoint = { time: Date; probability: number };

const historyResponse = z.looseObject({
  data: z
    .array(
      z.looseObject({
        timestamp: z.number(),
        price: z.number(),
        resolution_seconds: z.number().nullish(),
      }),
    )
    .nullish(),
  pagination: z
    .looseObject({ has_more: z.boolean().nullish(), next_cursor: z.string().nullish() })
    .nullish(),
});

/** Parses one page of /v2/prices-history. The trailing "latest" point (resolution 0) is dropped. */
export function parseHistory(payload: unknown): {
  points: PricePoint[];
  nextCursor: string | null;
} {
  const parsed = historyResponse.safeParse(payload);
  if (!parsed.success) return { points: [], nextCursor: null };
  const points = (parsed.data.data ?? [])
    .filter((d) => d.resolution_seconds !== 0 && d.price >= 0 && d.price <= 1 && d.timestamp > 0)
    .map((d) => ({ time: new Date(d.timestamp * 1000), probability: d.price }));
  const page = parsed.data.pagination;
  return { points, nextCursor: page?.has_more && page.next_cursor ? page.next_cursor : null };
}

export type FetchHistory = (
  tokenId: string,
  interval: "1d" | "1w" | "1m",
  bucketSeconds: number,
  signal?: AbortSignal,
) => Promise<PricePoint[]>;

/** Price history of one outcome token from the Data API v2, following the cursor. */
export const fetchPriceHistory: FetchHistory = async (tokenId, interval, bucketSeconds, signal) => {
  const points: PricePoint[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < 5; page++) {
    const url = new URL(`${DATA_API}/v2/prices-history`);
    url.searchParams.set("token_id", tokenId);
    url.searchParams.set("interval", interval);
    url.searchParams.set("bucket_seconds", String(bucketSeconds));
    if (cursor) url.searchParams.set("cursor", cursor);
    const parsed = parseHistory(await getJson(url, signal));
    points.push(...parsed.points);
    cursor = parsed.nextCursor;
    if (!cursor) break;
  }
  return points;
};
