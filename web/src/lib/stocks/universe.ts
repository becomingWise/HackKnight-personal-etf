import data from "./universe.data.json";

export type UniverseStock = { symbol: string; name: string; sectorId: string; sectorName: string };
export type UniverseSignal = {
  id: string;
  label: string;
  /** Polymarket search query that finds this signal's market. */
  query: string;
  /** Text that identifies the exact market among the search results, when there are several. */
  match: string | null;
  /** Sensitivity per ticker: positive means the stock benefits if the event gets more likely. */
  betas: Record<string, number>;
};

export const SECTORS = data.sectors;
// Each signal lists only some tickers, so the JSON type has optional keys.
export const SIGNALS = data.signals as unknown as UniverseSignal[];

/** The only tickers findStocks may return: the ones the weighting backend can tilt. */
export const STOCKS: UniverseStock[] = SECTORS.flatMap((sector) =>
  sector.holdings.map((h) => ({
    symbol: h.symbol,
    name: h.name,
    sectorId: sector.id,
    sectorName: sector.name,
  })),
);

export const STOCK_BY_SYMBOL = new Map(STOCKS.map((s) => [s.symbol, s]));
export const SYMBOLS = STOCKS.map((s) => s.symbol);
export const SECTOR_IDS = SECTORS.map((s) => s.id);

/** Signals with a beta to at least one ticker in the given sectors. */
export function signalsForSectors(sectorIds: string[]): UniverseSignal[] {
  const symbols = new Set(
    STOCKS.filter((s) => sectorIds.includes(s.sectorId)).map((s) => s.symbol),
  );
  return SIGNALS.filter((signal) => Object.keys(signal.betas).some((sym) => symbols.has(sym)));
}

// Used when Gemini is unavailable: plain keyword → sector matching. English, Chinese, Spanish,
// mirroring the languages the team's mock adapter recognizes.
const SECTOR_KEYWORDS: Record<string, string[]> = {
  semis: [
    "chip",
    "chips",
    "semiconductor",
    "semiconductors",
    "gpu",
    "foundry",
    "taiwan",
    "nvidia",
    "芯片",
    "半导体",
    "半導體",
    "晶片",
    "台湾",
    "台灣",
    "chips de",
  ],
  bigtech: [
    "ai",
    "a.i.",
    "artificial intelligence",
    "tech",
    "technology",
    "software",
    "cloud",
    "big tech",
    "openai",
    "internet",
    "人工智能",
    "人工智慧",
    "科技",
    "tecnología",
    "inteligencia artificial",
  ],
  energy: [
    "energy",
    "oil",
    "gas",
    "crude",
    "opec",
    "solar",
    "clean energy",
    "renewable",
    "climate",
    "hormuz",
    "iran",
    "能源",
    "石油",
    "太阳能",
    "清洁能源",
    "energía",
    "petróleo",
  ],
  defense: [
    "defense",
    "defence",
    "military",
    "war",
    "weapons",
    "missile",
    "nato",
    "ukraine",
    "russia",
    "geopolitics",
    "geopolitical",
    "conflict",
    "国防",
    "國防",
    "军工",
    "战争",
    "戰爭",
    "defensa",
    "guerra",
  ],
  financials: [
    "bank",
    "banks",
    "banking",
    "finance",
    "financial",
    "financials",
    "wall street",
    "lending",
    "银行",
    "銀行",
    "金融",
    "banco",
    "finanzas",
  ],
  crypto: [
    "crypto",
    "bitcoin",
    "btc",
    "ethereum",
    "blockchain",
    "web3",
    "stablecoin",
    "加密",
    "比特币",
    "比特幣",
    "criptomonedas",
  ],
  rates: [
    "rates",
    "interest rate",
    "interest rates",
    "fed",
    "federal reserve",
    "bond",
    "bonds",
    "treasury",
    "treasuries",
    "recession",
    "inflation",
    "soft landing",
    "credit",
    "利率",
    "债券",
    "債券",
    "衰退",
    "通胀",
    "tasas",
    "recesión",
    "inflación",
  ],
};

function hasKeyword(text: string, keyword: string): boolean {
  // Latin keywords need word boundaries ("ai" must not match "rain"); CJK matches anywhere.
  if (/[^\p{Script=Latin}\s.-]/u.test(keyword)) return text.includes(keyword);
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

/** Sector ids whose keywords appear in the idea, best match first. */
export function matchSectors(idea: string): string[] {
  const text = idea.toLocaleLowerCase();
  return SECTOR_IDS.map((id) => ({
    id,
    hits: (SECTOR_KEYWORDS[id] ?? []).filter((k) => hasKeyword(text, k)).length,
  }))
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((s) => s.id);
}
