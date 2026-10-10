import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export { ThinkingLevel };
import { env } from "../env";

export const GEMINI_MODEL = "gemini-3.5-flash";
/** Same family, separate quota: used for light tasks and when the main model is rate limited. */
export const GEMINI_LITE_MODEL = "gemini-3.5-flash-lite";

export type GenerateJsonArgs = {
  system: string;
  prompt: string;
  /** JSON Schema the response must follow. */
  schema: unknown;
  /** Client-side deadline. (The API rejects server deadlines under 10 s, so none is sent.) */
  timeoutMs: number;
  thinking?: ThinkingLevel;
  /** Which model to try first; the other one is the backup on quota (429) or overload (503). */
  prefer?: "main" | "lite";
  signal?: AbortSignal;
};

/** Returns the parsed JSON object Gemini produced. Throws on timeout, API error or non-JSON text. */
export type GenerateJson = (args: GenerateJsonArgs) => Promise<unknown>;

let client: GoogleGenAI | undefined;

export const geminiGenerateJson: GenerateJson = async ({
  system,
  prompt,
  schema,
  timeoutMs,
  thinking = ThinkingLevel.LOW,
  prefer = "main",
  signal,
}) => {
  const apiKey = env().GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  client ??= new GoogleGenAI({ apiKey });
  const timeout = AbortSignal.timeout(timeoutMs);
  const models =
    prefer === "lite" ? [GEMINI_LITE_MODEL, GEMINI_MODEL] : [GEMINI_MODEL, GEMINI_LITE_MODEL];
  let response: Awaited<ReturnType<typeof client.models.generateContent>> | undefined;
  for (const [i, model] of models.entries()) {
    try {
      response = await client.models.generateContent({
        model,
        contents: prompt,
        config: {
          systemInstruction: system,
          responseMimeType: "application/json",
          responseJsonSchema: schema,
          temperature: 0.4,
          abortSignal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          // Keeps latency predictable; these are short extraction and ranking tasks.
          thinkingConfig: { thinkingLevel: thinking },
        },
      });
      break;
    } catch (err) {
      const status = (err as { status?: number } | null)?.status;
      const busy = status === 429 || status === 503;
      if (!busy || i === models.length - 1) throw err;
      console.log(JSON.stringify({ at: "gemini", event: "model_busy", model, status }));
    }
  }
  if (!response) throw new Error("Gemini returned no response");
  const text = response.text;
  if (!text) throw new Error("Gemini returned no text");
  return JSON.parse(text);
};
