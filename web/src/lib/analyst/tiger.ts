// Option B of docs/HANDOFF.md: the analyst's output is read from Tiger (tables in migration
// 0007). A fresh packet for the idea is used as is; otherwise the signals analyst's search finds the
// markets and the analyst's per-market rows replace its analysis where they exist.
import { z } from "zod";
import { db } from "../db/client";
import { createSignalsAnalyst, type MarketAnalysis, type SignalsAnalystDeps } from "./signals";
import { SIGNALS, evidencePacketSchema, type Analyst, type EvidencePacket } from "./packet";

/** A stored packet older than this is ignored; the gate would reject it anyway. */
export const PACKET_MAX_AGE_MINUTES = 60;
const ANALYSIS_MAX_AGE_HOURS = 24;

export type AnalystStore = {
  latestPacket(idea: string): Promise<unknown | null>;
  marketAnalyses(ids: string[]): Promise<Map<string, MarketAnalysis>>;
};

const tickersSchema = z.array(
  z.object({
    symbol: z.string().trim().min(1).max(10),
    impact: z.number().min(-1).max(1),
    why: z.string().trim().min(1).max(300),
  }),
);

export const tigerAnalystStore: AnalystStore = {
  async latestPacket(idea) {
    const rows = await db()<{ packet: unknown }[]>`
      select packet from analyst_packets
      where idea_key = lower(btrim(regexp_replace(${idea}, '\s+', ' ', 'g')))
        and generated_at > now() - ${PACKET_MAX_AGE_MINUTES} * interval '1 minute'
      order by generated_at desc limit 1`;
    return rows[0]?.packet ?? null;
  },

  async marketAnalyses(ids) {
    if (!ids.length) return new Map();
    const rows = await db()<
      { market_id: string; signal: string; analyst_note: string; tickers: unknown }[]
    >`select market_id, signal, analyst_note, tickers from market_analysis
      where market_id = any(${ids})
        and analyzed_at > now() - ${ANALYSIS_MAX_AGE_HOURS} * interval '1 hour'`;
    const out = new Map<string, MarketAnalysis>();
    for (const row of rows) {
      const signal = z.enum(SIGNALS).safeParse(row.signal);
      const tickers = tickersSchema.safeParse(row.tickers);
      // A malformed row is skipped; the built-in analysis stands in for that market.
      if (!signal.success || !tickers.success) continue;
      out.set(row.market_id, {
        signal: signal.data,
        analystNote: row.analyst_note.slice(0, 400),
        tickers: tickers.data,
      });
    }
    return out;
  },
};

export function createTigerAnalyst(
  base: SignalsAnalystDeps,
  store: AnalystStore = tigerAnalystStore,
): Analyst {
  const overlaid = createSignalsAnalyst({ ...base, analyses: (ids) => store.marketAnalyses(ids) });
  return async function tigerAnalyst(idea, signal) {
    const stored = await store.latestPacket(idea);
    if (stored !== null) {
      // Invalid JSON in the table is the analyst's bug: fail loudly so the trace shows it.
      const packet: EvidencePacket = evidencePacketSchema.parse(stored);
      return { ...packet, idea };
    }
    return overlaid(idea, signal);
  };
}
