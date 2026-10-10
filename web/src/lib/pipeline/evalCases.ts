// Fixed ideas and mock evidence packets for `pnpm eval:decider`. The packets never change, so a
// change in the pass rate comes from the prompt or the model, not from the markets.
import type { EvidencePacket, Signal } from "../analyst/packet";

export type EvalCase = {
  name: string;
  idea: string;
  expect: "decision" | "not_enough_evidence";
  /** What this case is meant to catch. */
  probes: string;
  packet: (now: Date) => EvidencePacket;
};

type MarketSpec = {
  id: string;
  q: string;
  p: number;
  d7?: number | null;
  d1?: number | null;
  signal?: Signal;
  relevance?: number;
  liquidity?: number | null;
  note?: string;
};
type TickerSpec = [symbol: string, impact: number, marketIds: string[], why: string];
type ThemeSpec = [name: string, direction: Signal, confidence: number, marketIds: string[]];

function packet(
  idea: string,
  markets: MarketSpec[],
  tickers: TickerSpec[],
  themes: ThemeSpec[],
  warnings: string[] = [],
): (now: Date) => EvidencePacket {
  return (now) => ({
    idea,
    generatedAt: now.toISOString(),
    markets: markets.map((m) => ({
      id: m.id,
      question: m.q,
      url: `https://polymarket.com/event/eval-${m.id}`,
      probability: m.p,
      change24h: m.d1 ?? 0,
      change7d: m.d7 === undefined ? 0 : m.d7,
      volume24h: 25_000,
      liquidity: m.liquidity === undefined ? 80_000 : m.liquidity,
      endDate: new Date(now.getTime() + 90 * 86_400_000).toISOString(),
      relevance: m.relevance ?? 0.8,
      signal: m.signal ?? "neutral",
      analystNote: m.note ?? "",
    })),
    themes: themes.map(([name, direction, confidence, marketIds]) => ({
      name,
      direction,
      confidence,
      marketIds,
    })),
    tickerSignals: tickers.map(([symbol, impact, marketIds, why]) => ({
      symbol,
      impact,
      marketIds,
      why,
    })),
    warnings,
  });
}

function evalCase(
  name: string,
  idea: string,
  probes: string,
  markets: MarketSpec[],
  tickers: TickerSpec[],
  themes: ThemeSpec[],
  options: { warnings?: string[]; expect?: EvalCase["expect"] } = {},
): EvalCase {
  return {
    name,
    idea,
    probes,
    expect: options.expect ?? "decision",
    packet: packet(idea, markets, tickers, themes, options.warnings),
  };
}

export const EVAL_CASES: EvalCase[] = [
  evalCase(
    "chips-taiwan",
    "AI chips and Taiwan risk",
    "the baseline demo idea",
    [
      {
        id: "101",
        q: "Will China invade Taiwan by December 31, 2027?",
        p: 0.075,
        d7: -0.01,
        signal: "bullish",
        note: "Invasion odds are low and easing, which removes pressure from Taiwan-based fabs.",
      },
      {
        id: "102",
        q: "Will AI-chip export licensing become law this year?",
        p: 0.22,
        d7: 0.03,
        signal: "bearish",
        note: "Licensing would cap sales of advanced AI chips abroad.",
      },
      {
        id: "103",
        q: "Will NVIDIA be the largest company by market cap on December 31?",
        p: 0.64,
        d7: 0.02,
        signal: "bullish",
      },
    ],
    [
      ["TSM", 0.2, ["101"], "Its leading-edge fabs are in Taiwan."],
      ["NVDA", 0.1, ["102", "103"], "Export rules cap its sales; AI demand lifts it."],
      ["AMD", -0.1, ["102"], "Export licensing limits its data-center chips too."],
      ["ASML", 0.1, ["101", "102"], "Its machines are subject to export rules and Taiwan demand."],
      ["INTC", -0.1, ["101"], "Domestic fabs matter more when Taiwan risk rises."],
    ],
    [["Semiconductors", "bullish", 0.6, ["101", "102", "103"]]],
  ),
  evalCase(
    "fed-housing",
    "Fed rate cuts and housing",
    "an idea whose obvious stocks (home builders) are not in the universe",
    [
      {
        id: "201",
        q: "Will no Fed rate cuts happen in 2026?",
        p: 0.12,
        d7: -0.04,
        signal: "bullish",
        note: "The market expects cuts; lower rates lift bond prices.",
      },
      {
        id: "202",
        q: "Will the Fed cut rates at its December meeting?",
        p: 0.58,
        d7: 0.05,
        signal: "bullish",
      },
      {
        id: "203",
        q: "Will there be a US recession by end of 2026?",
        p: 0.31,
        d7: 0.01,
        signal: "bearish",
      },
    ],
    [
      ["TLT", 0.4, ["201", "202"], "Long Treasuries rise when rates fall."],
      ["IEF", 0.3, ["201", "202"], "Intermediate Treasuries rise when rates fall."],
      [
        "BAC",
        0.1,
        ["202", "203"],
        "Mortgage lending picks up with lower rates; a recession hurts credit.",
      ],
      [
        "JPM",
        0.1,
        ["202", "203"],
        "Mortgage lending picks up with lower rates; a recession hurts credit.",
      ],
      ["LQD", 0.2, ["201"], "Corporate bonds gain when rates fall."],
    ],
    [["Rates & Credit", "bullish", 0.7, ["201", "202"]]],
    { warnings: ["No home builders or REITs are in the supported universe."] },
  ),
  evalCase(
    "clean-energy",
    "Clean energy after the election",
    "only one clean-energy stock exists; the rest must be honestly tied to energy markets",
    [
      {
        id: "301",
        q: "Will the solar investment tax credit be repealed in 2026?",
        p: 0.18,
        d7: -0.02,
        signal: "bullish",
        note: "A repeal would remove the main subsidy for US solar manufacturing.",
      },
      {
        id: "302",
        q: "Will Democrats win the House in the 2026 midterms?",
        p: 0.71,
        d7: 0.01,
        signal: "bullish",
      },
      {
        id: "303",
        q: "Will WTI crude close above $90 this year?",
        p: 0.09,
        d7: 0,
        signal: "neutral",
      },
    ],
    [
      ["FSLR", 0.5, ["301", "302"], "First Solar depends on the solar tax credit."],
      ["XOM", -0.1, ["303", "302"], "Oil majors lose from a stronger clean-energy push."],
      ["CVX", -0.1, ["303", "302"], "Oil majors lose from a stronger clean-energy push."],
      ["SLB", -0.1, ["303"], "Oil services follow the oil price."],
    ],
    [["Energy", "bullish", 0.5, ["301", "302", "303"]]],
  ),
  evalCase(
    "crypto-regulation",
    "Crypto regulation",
    "several markets per stock",
    [
      {
        id: "401",
        q: "Will a crypto market structure bill be signed into law in 2026?",
        p: 0.44,
        d7: 0.06,
        signal: "bullish",
      },
      {
        id: "402",
        q: "Will Bitcoin close above $150,000 this year?",
        p: 0.13,
        d7: -0.02,
        signal: "neutral",
      },
      {
        id: "403",
        q: "Will the SEC approve a spot Solana ETF by December 31?",
        p: 0.86,
        d7: 0.01,
        signal: "bullish",
      },
    ],
    [
      ["COIN", 0.5, ["401", "403"], "Clear rules and new listed products grow exchange volume."],
      ["HOOD", 0.4, ["401", "403"], "Clear rules widen what a retail broker may offer."],
      ["IBIT", 0.1, ["402"], "It tracks the Bitcoin price."],
      ["MSTR", 0.1, ["402"], "Its balance sheet is Bitcoin."],
      ["MARA", 0.1, ["402"], "Miners earn more when Bitcoin rises."],
    ],
    [["Crypto", "bullish", 0.7, ["401", "402", "403"]]],
  ),
  evalCase(
    "nato-rearms",
    "The war in Ukraine keeps going and NATO rearms",
    "a percentage inside a market question (3.5%) must not be confused with odds",
    [
      {
        id: "501",
        q: "Will Russia and Ukraine agree a ceasefire by December 31?",
        p: 0.23,
        d7: -0.05,
        signal: "bullish",
        note: "Ceasefire odds are falling, so demand for munitions stays high.",
      },
      {
        id: "502",
        q: "Will NATO adopt a 3.5% of GDP defense spending target this year?",
        p: 0.61,
        d7: 0.04,
        signal: "bullish",
      },
      {
        id: "503",
        q: "Will the US approve a new Ukraine aid package in 2026?",
        p: 0.37,
        d7: 0,
        signal: "neutral",
      },
    ],
    [
      ["LMT", 0.5, ["501", "502"], "Missiles and air defense are in demand while the war lasts."],
      ["RTX", 0.5, ["501", "502", "503"], "Patriot interceptors are funded by aid packages."],
      ["NOC", 0.3, ["502"], "Higher NATO budgets fund long-term programs."],
      ["GD", 0.3, ["501", "502"], "Artillery shells and armored vehicles."],
      ["LHX", 0.2, ["502"], "Communications and sensors for allied forces."],
    ],
    [["Defense", "bullish", 0.8, ["501", "502", "503"]]],
  ),
  evalCase(
    "oil-iran-spanish",
    "Creo que el petróleo va a subir por el conflicto con Irán",
    "a Spanish idea: the answer is in Spanish, numbers still exact",
    [
      {
        id: "601",
        q: "Will Iran close the Strait of Hormuz in 2026?",
        p: 0.06,
        d7: 0.01,
        signal: "bullish",
      },
      {
        id: "602",
        q: "Will the US strike Iran before December 31?",
        p: 0.15,
        d7: 0.03,
        signal: "bullish",
      },
      {
        id: "603",
        q: "Will WTI crude close above $100 this year?",
        p: 0.11,
        d7: 0.02,
        signal: "bullish",
      },
    ],
    [
      ["XOM", 0.3, ["601", "603"], "Higher crude prices lift upstream profits."],
      ["CVX", 0.3, ["601", "603"], "Higher crude prices lift upstream profits."],
      ["COP", 0.4, ["603"], "A pure producer, most sensitive to the oil price."],
      ["OXY", 0.4, ["603"], "High leverage to the oil price."],
      ["SLB", 0.2, ["602", "603"], "Drilling activity follows the oil price."],
    ],
    [["Energy", "bullish", 0.6, ["601", "602", "603"]]],
  ),
  evalCase(
    "robotaxis",
    "Electric cars and robotaxis",
    "the analyst's strongest ticker signals are outside the universe; only allowed tickers may be picked",
    [
      {
        id: "701",
        q: "Will Tesla launch unsupervised FSD in California by December 31?",
        p: 0.28,
        d7: -0.03,
        signal: "bearish",
      },
      {
        id: "702",
        q: "Will Waymo operate paid rides in 10 US cities by year end?",
        p: 0.62,
        d7: 0.04,
        signal: "bullish",
      },
      {
        id: "703",
        q: "Will Zoox open its robotaxi service to the public in Las Vegas this year?",
        p: 0.47,
        d7: 0,
        signal: "neutral",
      },
      {
        id: "704",
        q: "Will NVIDIA be the largest company by market cap on December 31?",
        p: 0.55,
        d7: 0.01,
        signal: "bullish",
        relevance: 0.5,
      },
    ],
    [
      ["TSLA", -0.4, ["701"], "Robotaxi revenue depends on unsupervised FSD."],
      ["UBER", 0.3, ["702"], "Waymo rides are booked through Uber in several cities."],
      ["GOOGL", 0.5, ["702"], "Waymo is an Alphabet company."],
      ["AMZN", 0.2, ["703"], "Zoox is owned by Amazon."],
      ["NVDA", 0.2, ["704", "702"], "Autonomous driving runs on its chips."],
    ],
    [["Autonomous driving", "bullish", 0.5, ["701", "702", "703"]]],
    { warnings: ["Tesla and Uber are not in the supported universe."] },
  ),
  evalCase(
    "banks-contrarian",
    "Banks will do great next year",
    "the evidence contradicts the idea; reasons must stay honest",
    [
      {
        id: "801",
        q: "Will there be a US recession by end of 2026?",
        p: 0.45,
        d7: 0.09,
        signal: "bearish",
        note: "Recession odds rose sharply this week; credit losses hit banks first.",
      },
      { id: "802", q: "Will a major US bank fail in 2026?", p: 0.04, d7: 0, signal: "neutral" },
      {
        id: "803",
        q: "Will the Fed cut rates at its December meeting?",
        p: 0.58,
        d7: 0.05,
        signal: "bearish",
        note: "Cuts squeeze net interest margins.",
      },
    ],
    [
      ["JPM", -0.4, ["801", "803"], "Credit losses and lower margins."],
      ["BAC", -0.5, ["801", "803"], "The most rate-sensitive large bank."],
      ["GS", -0.3, ["801"], "Deal activity falls in a recession."],
      ["MS", -0.3, ["801"], "Deal activity falls in a recession."],
      ["SCHW", -0.2, ["803"], "Lower rates cut interest income on client cash."],
    ],
    [["Financials", "bearish", 0.7, ["801", "803"]]],
    { warnings: ["The evidence points against the idea."] },
  ),
  evalCase(
    "bitcoin-momentum",
    "Bitcoin momentum is back",
    "large odds moves invite quoting them: moves must be in points and exact",
    [
      {
        id: "901",
        q: "Will Bitcoin close above $150,000 this year?",
        p: 0.31,
        d7: 0.062,
        d1: 0.014,
        signal: "bullish",
        note: "Odds jumped this week on ETF inflows.",
      },
      {
        id: "902",
        q: "Will Bitcoin fall below $80,000 before December 31?",
        p: 0.08,
        d7: -0.045,
        d1: -0.01,
        signal: "bullish",
      },
      {
        id: "903",
        q: "Will MicroStrategy buy more than 50,000 BTC this quarter?",
        p: 0.52,
        d7: 0.11,
        d1: 0.02,
        signal: "bullish",
      },
    ],
    [
      ["IBIT", 0.6, ["901", "902"], "It tracks the Bitcoin price."],
      ["MSTR", 0.8, ["901", "903"], "Its balance sheet is Bitcoin and it keeps buying."],
      ["COIN", 0.4, ["901"], "Trading volume rises with the price."],
      ["MARA", 0.5, ["901", "902"], "Miners earn more when Bitcoin rises."],
      ["HOOD", 0.3, ["901"], "Retail crypto trading returns in rallies."],
    ],
    [["Crypto", "bullish", 0.8, ["901", "902", "903"]]],
  ),
  evalCase(
    "thin-evidence",
    "Underwater basket weaving championships",
    "the gate must stop this before Gemini is called",
    [
      { id: "1001", q: "Will the 2028 Olympics add a new water sport?", p: 0.2, relevance: 0.2 },
      {
        id: "1002",
        q: "Will a basket weaving world record be set this year?",
        p: 0.5,
        relevance: 0.7,
        liquidity: 120,
      },
    ],
    [],
    [],
    { expect: "not_enough_evidence", warnings: ["Almost no markets found."] },
  ),
];
