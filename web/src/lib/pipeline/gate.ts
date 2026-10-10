// Stage b, the GATE: plain code that decides whether the evidence is good enough to spend a
// Gemini call on. It also narrows the packet to the usable markets, so the later stages can only
// cite evidence that passed.
import type { EvidencePacket } from "../analyst/packet";

export const GATE = {
  /** A market counts when the analyst rates it at least this relevant… */
  minRelevance: 0.4,
  /** …it has at least this much liquidity in dollars (unknown liquidity does not count)… */
  minLiquidity: 1000,
  /** …and it is still open with a real price. The packet itself must be this recent. */
  maxPacketAgeMinutes: 60,
  /** How many such markets an answer needs. */
  minMarkets: 2,
};

export type GateResult = {
  ok: boolean;
  /** The packet restricted to usable markets (themes and ticker signals pruned to match). */
  packet: EvidencePacket;
  /** One line for the trace. */
  summary: string;
  /** For the user when the gate fails. */
  message: string;
};

export function gate(packet: EvidencePacket, now: Date = new Date()): GateResult {
  const ageMinutes = (now.getTime() - Date.parse(packet.generatedAt)) / 60_000;
  const stale = ageMinutes > GATE.maxPacketAgeMinutes;

  const rejected = { irrelevant: 0, illiquid: 0, ended: 0 };
  const usable = packet.markets.filter((m) => {
    const ended =
      (m.endDate !== null && Date.parse(m.endDate) <= now.getTime()) ||
      m.probability <= 0 ||
      m.probability >= 1;
    if (ended) rejected.ended++;
    else if (m.relevance < GATE.minRelevance) rejected.irrelevant++;
    else if (m.liquidity === null || m.liquidity < GATE.minLiquidity) rejected.illiquid++;
    else return true;
    return false;
  });

  const ids = new Set(usable.map((m) => m.id));
  const prune = <T extends { marketIds: string[] }>(items: T[]) =>
    items
      .map((item) => ({ ...item, marketIds: item.marketIds.filter((id) => ids.has(id)) }))
      .filter((item) => item.marketIds.length > 0);
  const narrowed: EvidencePacket = {
    ...packet,
    markets: usable,
    themes: prune(packet.themes),
    tickerSignals: prune(packet.tickerSignals),
  };

  const counts =
    `${usable.length} of ${packet.markets.length} markets usable` +
    (packet.markets.length > usable.length
      ? ` (${rejected.irrelevant} not relevant, ${rejected.illiquid} illiquid, ${rejected.ended} ended)`
      : "");
  if (stale) {
    return {
      ok: false,
      packet: narrowed,
      summary: `not enough evidence: the packet is ${Math.round(ageMinutes)} minutes old (limit ${GATE.maxPacketAgeMinutes})`,
      message: "The market evidence for this idea is out of date. Please try again.",
    };
  }
  if (usable.length < GATE.minMarkets) {
    return {
      ok: false,
      packet: narrowed,
      summary: `not enough evidence: ${counts}, need ${GATE.minMarkets}`,
      message:
        "Not enough live Polymarket evidence for this idea yet. Try naming a sector, event or theme (for example chips, oil, the Fed, crypto, defense).",
    };
  }
  return { ok: true, packet: narrowed, summary: `passed: ${counts}`, message: "" };
}
