import { readFile } from "node:fs/promises";
import { createController } from "../js/controller.js";
import { createMockServices } from "../js/services.js";

const idea = process.argv.slice(2).join(" ") || "I care about clean energy";
const services = createMockServices({
  loadFixtures: async () => JSON.parse(await readFile(new URL("../data/chat-demo.json", import.meta.url), "utf8")),
  wait: async () => {}
});
const controller = createController(services);
console.log("MyETF framework demo — fictional companies and simulated adjustments.\n");
const stop = controller.subscribe(({ status, view }) => console.log(`${status} → ${view}`));
await controller.submitIdea(idea);
stop();
const state = controller.getState();
if (state.error) {
  console.error(state.error);
  process.exitCode = 1;
} else {
  console.log(`\nIdea: ${state.idea}\n${state.summary}\n`);
  console.table(state.stocks.map(stock => ({
    symbol: stock.symbol,
    company: stock.name,
    startingPct: state.startingHoldings.find(item => item.symbol === stock.symbol).weightPct,
    currentPct: state.holdings.find(item => item.symbol === stock.symbol).weightPct
  })));
  console.log(state.adjustment.explanation);
}
