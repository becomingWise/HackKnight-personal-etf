// Resolves the universe's signals to live Polymarket markets.
// Port of _resolve / signals in /backend/src/polyslice_api/polymarket.py: same query, same
// match rule, same price (outcomePrices[0]) so both services tilt identically. Read-only.
import { SIGNALS, type UniverseSignal } from "../stocks/universe";
import { recordObservations } from "../odds/service";
import type { Signal } from "./engine";

const GAMMA = "https://gamma-api.polymarket.com";
const HEADERS = {
  "User-Agent": "prophetf/0.1 (hackathon demo, read-only)",
  Accept: "application/json",
};
const SIGNAL_TTL_MS = 60_000;

type Raw = Record<string, unknown>;

function yesPrice(market: Raw): number | null {
  try {
    const price = Number(JSON.parse(String(market.outcomePrices))[0]);
    return Number.isFinite(price) ? price : null;
  } catch {
    return null;
  }
}

function isLive(market: Raw): boolean {
  const price = yesPrice(market);
  return !!market.active && !market.closed && price !== null && price > 0 && price < 1;
}

function tokenIds(market: Raw): string[] {
  // v2 markets list outcome ids in positionIds (array); v1 in clobTokenIds (JSON text).
  const position = Array.isArray(market.positionIds) ? market.positionIds.map(String) : [];
  let clob: string[] = [];
  try {
    const ids = JSON.parse(String(market.clobTokenIds ?? "[]"));
    if (Array.isArray(ids)) clob = ids.map(String);
  } catch {
    clob = [];
  }
  const [first, second] = market.version === "v2" ? [position, clob] : [clob, position];
  return first.length ? first : second;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const volume = (market: Raw): number => Number(market.volume ?? 0) || 0;

/** Picks the live market whose question contains the signal's match text, highest volume first. */
export function resolveSignal(cfg: UniverseSignal, payload: unknown): Signal {
  const base: Signal = {
    id: cfg.id,
    label: cfg.label,
    betas: cfg.betas,
    price: null,
    status: "unavailable",
  };
  const needle = (cfg.match ?? "").toLowerCase();
  let best: { event: Raw; market: Raw } | null = null;
  const events = (payload as { events?: unknown } | null)?.events;
  for (const event of Array.isArray(events) ? (events as Raw[]) : []) {
    if (!event || event.closed) continue;
    for (const market of Array.isArray(event.markets) ? (event.markets as Raw[]) : []) {
      const question = typeof market?.question === "string" ? market.question : "";
      if (question.toLowerCase().includes(needle) && isLive(market)) {
        if (best === null || volume(market) > volume(best.market)) best = { event, market };
      }
    }
  }
  if (best === null) return base;
  return {
    ...base,
    question: String(best.market.question).trim(),
    marketId: best.market.id === undefined ? undefined : String(best.market.id),
    tokenIds: tokenIds(best.market),
    endDate: typeof best.market.endDate === "string" ? best.market.endDate : null,
    url: `https://polymarket.com/event/${best.event.slug}`,
    price: yesPrice(best.market),
    changes: {
      "1d": num(best.market.oneDayPriceChange),
      "1w": num(best.market.oneWeekPriceChange),
      "1m": num(best.market.oneMonthPriceChange),
    },
    status: "live",
  };
}

async function resolve(cfg: UniverseSignal): Promise<Signal> {
  const url = new URL(`${GAMMA}/public-search`);
  url.searchParams.set("q", cfg.query);
  url.searchParams.set("limit_per_type", "20");
  url.searchParams.set("events_status", "active");
  try {
    const res = await fetch(url, {
      headers: HEADERS,
      signal: AbortSignal.timeout(15_000),
      cache: "no-store",
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return resolveSignal(cfg, await res.json());
  } catch {
    return { id: cfg.id, label: cfg.label, betas: cfg.betas, price: null, status: "unavailable" };
  }
}

let cached: { expires: number; value: Promise<Signal[]> } | undefined;

/** All universe signals with live odds, cached for 60 s like the Python service. */
export function liveSignals(): Promise<Signal[]> {
  if (cached && cached.expires > Date.now()) return cached.value;
  const value = Promise.all(SIGNALS.map(resolve)).then(async (signals) => {
    // Every fresh lookup also feeds the odds history in Tiger.
    await recordObservations(
      signals.flatMap((sig) =>
        sig.status === "live" && sig.marketId && sig.price !== null
          ? [
              {
                id: sig.marketId,
                question: sig.question ?? sig.label,
                url: sig.url,
                yesTokenId: sig.tokenIds?.[0],
                endDate: sig.endDate,
                probability: sig.price,
              },
            ]
          : [],
      ),
      "weights",
    ).catch(() => {});
    return signals;
  });
  cached = { expires: Date.now() + SIGNAL_TTL_MS, value };
  // A fully failed lookup must not be served for a minute.
  value.then((signals) => {
    if (signals.every((s) => s.status !== "live") && cached?.value === value) cached = undefined;
  });
  return value;
}
