import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export { ThinkingLevel };
import { env } from "../env";

export const GEMINI_MODEL = "gemini-3.5-flash";

export type GenerateJsonArgs = {
  system: string;
  prompt: string;
  /** JSON Schema the response must follow. */
  schema: unknown;
  /** Client-side deadline. (The API rejects server deadlines under 10 s, so none is sent.) */
  timeoutMs: number;
  thinking?: ThinkingLevel;
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
  signal,
}) => {
  const apiKey = env().GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  client ??= new GoogleGenAI({ apiKey });
  const timeout = AbortSignal.timeout(timeoutMs);
  const response = await client.models.generateContent({
    model: GEMINI_MODEL,
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
  const text = response.text;
  if (!text) throw new Error("Gemini returned no text");
  return JSON.parse(text);
};
