// GET /api/savings: today's answers, how many were reused, and the Gemini calls made.
// Contract: docs/API.md section 1e.
import { preflight } from "../http/cors";
import { error, json } from "../http/respond";
import { tigerSavings, type SavingsStore } from "./store";

export type SavingsDeps = { store: SavingsStore; now?: () => Date };

export function createSavingsHandler(deps: SavingsDeps = { store: tigerSavings }) {
  async function GET(request: Request): Promise<Response> {
    try {
      return json(request, 200, await deps.store.read(deps.now?.()));
    } catch (err) {
      console.log(
        JSON.stringify({ at: "savings", event: "error", message: String(err).slice(0, 200) }),
      );
      return error(request, 503, "storage_error", "The counters are unavailable. Try again.");
    }
  }
  return { GET, OPTIONS: (request: Request): Response => preflight(request) };
}
