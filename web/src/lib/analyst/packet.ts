// The EvidencePacket: what the ANALYST hands to the DECIDER. This file is the contract;
// docs/HANDOFF.md explains it with a full example and docs/API.md documents the endpoints.
import { z } from "zod";

export const SIGNALS = ["bullish", "bearish", "neutral"] as const;
export type Signal = (typeof SIGNALS)[number];

const text = (max: number) => z.string().trim().min(1).max(max);
const unit = z.number().min(0).max(1);
const change = z.number().min(-1).max(1).nullable();
/** Any timestamp `Date.parse` understands, e.g. "2026-10-10T12:00:00Z" or Python's isoformat(). */
const time = z.string().refine((s) => Number.isFinite(Date.parse(s)), "must be an ISO date-time");

const marketSchema = z.object({
  /** Polymarket's numeric market id, as a string. */
  id: text(40),
  question: text(300),
  url: z.url(),
  /** Current odds of "Yes", 0 to 1. */
  probability: unit,
  /** Change of `probability` over 24 hours and 7 days, in probability units (0.03 = +3 points). */
  change24h: change,
  change7d: change,
  /** US dollars. */
  volume24h: z.number().min(0).nullable(),
  liquidity: z.number().min(0).nullable(),
  endDate: time.nullable(),
  /** How much this market matters for the idea, 0 to 1. */
  relevance: unit,
  /** What the market's level and recent move mean for the idea's stocks overall. */
  signal: z.enum(SIGNALS),
  /** One or two sentences of analysis. The decider reads it; numbers in it may be quoted. */
  analystNote: z.string().trim().max(400),
});

const themeSchema = z.object({
  name: text(80),
  direction: z.enum(SIGNALS),
  confidence: unit,
  marketIds: z.array(text(40)).max(40),
});

const tickerSignalSchema = z.object({
  symbol: text(10),
  /** Net expected effect on the ticker: -1 strongly negative, 0 none, +1 strongly positive. */
  impact: z.number().min(-1).max(1),
  marketIds: z.array(text(40)).min(1).max(40),
  why: text(300),
});

export const evidencePacketSchema = z
  .object({
    idea: text(500),
    generatedAt: time,
    /** Most relevant first. */
    markets: z.array(marketSchema).max(40),
    themes: z.array(themeSchema).max(12),
    /** Most important first. Tickers outside the 40-stock universe are ignored by the decider. */
    tickerSignals: z.array(tickerSignalSchema).max(60),
    /** Anything the decider should know: missing data, stale sources, low coverage. */
    warnings: z.array(text(300)).max(20),
  })
  .superRefine((packet, ctx) => {
    const ids = new Set<string>();
    for (const m of packet.markets) {
      if (ids.has(m.id)) ctx.addIssue({ code: "custom", message: `duplicate market id ${m.id}` });
      ids.add(m.id);
    }
    const refs = [
      ...packet.themes.map((t) => [`theme "${t.name}"`, t.marketIds] as const),
      ...packet.tickerSignals.map((t) => [`tickerSignal ${t.symbol}`, t.marketIds] as const),
    ];
    for (const [owner, marketIds] of refs) {
      for (const id of marketIds) {
        if (!ids.has(id)) {
          ctx.addIssue({ code: "custom", message: `${owner} cites unknown market id ${id}` });
        }
      }
    }
  });

export type EvidencePacket = z.infer<typeof evidencePacketSchema>;
export type PacketMarket = EvidencePacket["markets"][number];

/** The analyst stage: an idea in, an evidence packet out. Throws when it cannot answer. */
export type Analyst = (idea: string, signal?: AbortSignal) => Promise<EvidencePacket>;
