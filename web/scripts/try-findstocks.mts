// Manual check of the findStocks pipeline against real Gemini and live Polymarket:
//   pnpm try:findstocks "AI chips and Taiwan risk"
import { searchMarkets } from "../src/lib/polymarket/search";
import { geminiGenerateJson, type GenerateJson } from "../src/lib/sponsors/gemini";
import { findStocks } from "../src/lib/stocks/findStocks";

const idea = process.argv.slice(2).join(" ") || "AI chips and Taiwan risk";

const timedGenerate: GenerateJson = async (args) => {
  const started = Date.now();
  try {
    const out = await geminiGenerateJson(args);
    console.log(`gemini ok in ${Date.now() - started} ms`);
    return out;
  } catch (err) {
    console.log(`gemini FAILED in ${Date.now() - started} ms: ${String(err).slice(0, 300)}`);
    throw err;
  }
};

const started = Date.now();
const result = await findStocks(
  { idea },
  {
    generate: timedGenerate,
    search: searchMarkets,
    log: (e, d) => console.log(e, JSON.stringify(d)),
  },
);
console.log(JSON.stringify(result, null, 2));
console.log(`total ${Date.now() - started} ms, source ${result.source}`);
