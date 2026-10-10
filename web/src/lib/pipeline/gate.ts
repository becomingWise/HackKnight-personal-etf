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

/** Why there is not enough evidence, for the user: the most common reason markets were rejected. */
function why(
  usable: number,
  found: number,
  rejected: { irrelevant: number; illiquid: number; ended: number },
): string {
  if (!found) return "Polymarket has no open markets that match this idea.";
  const lead =
    usable === 1
      ? "Only one Polymarket market could be used for this idea, and an answer needs at least two. "
      : "";
  const top = Math.max(rejected.irrelevant, rejected.illiquid, rejected.ended);
  if (top === rejected.irrelevant) {
    return `${lead}Polymarket has open markets near this idea, but they do not connect it to the stocks we cover (chips, AI and big tech, energy, defense, banks, crypto, interest rates).`;
  }
  if (top === rejected.illiquid) {
    return `${lead}The Polymarket markets on this idea have too little money in them for their odds to be trusted.`;
  }
  return `${lead}The Polymarket markets on this idea have already closed.`;
}

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
      message:
        "The market data collected for this idea is more than an hour old, so it was not used.",
    };
  }
  if (usable.length < GATE.minMarkets) {
    return {
      ok: false,
      packet: narrowed,
      summary: `not enough evidence: ${counts}, need ${GATE.minMarkets}`,
      message: why(usable.length, packet.markets.length, rejected),
    };
  }
  return { ok: true, packet: narrowed, summary: `passed: ${counts}`, message: "" };
}
