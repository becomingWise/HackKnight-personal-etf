import { refreshSnapshot, saveSnapshot } from "./data.js";
const data = await refreshSnapshot();
await saveSnapshot(data, process.argv.includes("--snapshot"));
console.log(JSON.stringify({ builtAt: data.builtAt, stocks: Object.values(data.stocks).filter(s => s.prices.length).length,
  events: data.events.filter(e => e.status === "available").length, histories: data.events.filter(e => e.history.length).length }));
