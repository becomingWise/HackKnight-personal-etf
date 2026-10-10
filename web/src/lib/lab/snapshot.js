// The Lab's committed snapshot (prices and event odds), bundled into the function: on Vercel the
// Lab is read-only and never refreshes. Kept in a .js file with its own types so that TypeScript
// does not have to read 2 MB of JSON.
import data from "../agent-core/experiment/data/snapshot.json" with { type: "json" };
import { normalizeSnapshot } from "../agent-core/experiment/data.js";

export const snapshot = normalizeSnapshot(data);
