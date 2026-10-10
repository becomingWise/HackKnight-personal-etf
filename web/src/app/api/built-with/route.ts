// GET /api/built-with — live proof per sponsor, as JSON for the frontend to render.
import { connection } from "next/server";
import { geminiProof } from "@/lib/builtwith/gemini";
import { tigerProof } from "@/lib/builtwith/tiger";
import { sponsorStatus } from "@/lib/flags";
import { preflight } from "@/lib/http/cors";
import { error, json } from "@/lib/http/respond";
import { GEMINI_LITE_MODEL, GEMINI_MODEL } from "@/lib/sponsors/gemini";

export const maxDuration = 30;

export async function GET(request: Request) {
  await connection();
  const status = sponsorStatus();
  try {
    const tiger = await tigerProof();
    return json(request, 200, {
      generatedAt: new Date().toISOString(),
      tiger: { ...status.tiger, ...tiger },
      gemini: {
        ...status.gemini,
        model: GEMINI_MODEL,
        backupModel: GEMINI_LITE_MODEL,
        usedFor: [
          "POST /api/stocks: plans Polymarket searches, then picks and explains stocks",
          "POST /api/baskets/{id}/letter: writes the manager's note for a saved basket",
        ],
        ...(await geminiProof()),
      },
      elevenlabs: status.elevenlabs,
      solana: status.solana,
      presage: status.presage,
    });
  } catch (err) {
    console.log(
      JSON.stringify({ at: "built-with", event: "error", message: String(err).slice(0, 200) }),
    );
    return error(request, 503, "storage_error", "Sponsor proof is unavailable. Please try again.");
  }
}

export const OPTIONS = (request: Request) => preflight(request);
