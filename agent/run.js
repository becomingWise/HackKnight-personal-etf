// Local CLI for the stock agent:
//   node agent/run.js "AI chips and Taiwan risk"
//   node agent/run.js --session alice "I never want oil companies. Clean energy please"
// Needs agent/.env with GEMINI_API_KEY (copy agent/.env.example). Each run is one request:
// 2 Gemini calls normally, 4 at most.
import { loadAgentEnv } from "./env.js";
import { createFindStocks } from "./gemini.js";

const args = process.argv.slice(2);
const flag = name => {
  const index = args.indexOf(name);
  return index >= 0 ? args.splice(index, 2)[1] : undefined;
};
const session = flag("--session");
const idea = args.join(" ").trim();

if (!idea) {
  console.error('Usage: node agent/run.js [--session <id>] "your idea"');
  process.exit(1);
}
if (!loadAgentEnv() && !process.env.GEMINI_API_KEY) {
  console.error("agent/.env not found. Copy agent/.env.example to agent/.env and add GEMINI_API_KEY.");
  process.exit(1);
}

const findStocks = createFindStocks({
  log: event => {
    if (event.event === "model_call") console.error(`  call ${event.call}: ${event.model} (${event.purpose}, ${event.ms} ms)`);
    if (event.event === "tool") console.error(`  tool: ${event.name}`);
    if (event.event === "model_failed") console.error(`  ${event.model} failed: ${event.status}`);
  }
});

try {
  const result = await findStocks({ idea }, { sessionId: session, basket: true });
  const { basket, ...selection } = result;
  console.log(JSON.stringify(selection, null, 2));
  console.table(basket.holdings);
} catch (error) {
  console.error(`${error.code ?? "error"}: ${error.message}`);
  process.exit(1);
}
