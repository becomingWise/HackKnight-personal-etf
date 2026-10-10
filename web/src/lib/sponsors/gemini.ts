// Gemini calls for the whole app. A call names its task; the task's chain of models
// (src/lib/gemini/models.ts) is walked until one answers. A model is skipped when it is blocked
// or over its per-minute or per-day budget (src/lib/gemini/budget.ts, counted in Tiger), and
// blocked after a 429 so it is never retried in the same minute.
import { GoogleGenAI, ThinkingLevel } from "@google/genai";

export { ThinkingLevel };
import { env } from "../env";
import { tigerModelBudget, type ModelBudget } from "../gemini/budget";
import { MODELS, chainFor, periods, type ModelId, type Task } from "../gemini/models";

export type GenerateJsonArgs = {
  system: string;
  prompt: string;
  /** JSON Schema the response must follow. */
  schema: unknown;
  /** Client-side deadline for the whole call, across every model tried. (The API rejects server deadlines under 10 s, so none is sent.) */
  timeoutMs: number;
  thinking?: ThinkingLevel;
  /** What the call is for; it selects the chain of models. Default: "decide". */
  task?: Task;
  /** Told which model produced the answer. */
  onModel?: (model: string) => void;
  signal?: AbortSignal;
};

/** Returns the parsed JSON object Gemini produced. Throws on timeout, API error or non-JSON text. */
export type GenerateJson = (args: GenerateJsonArgs) => Promise<unknown>;

/** No model of the chain could be used: all blocked, over budget, or rate limited. */
export class GeminiUnavailableError extends Error {
  constructor(readonly tried: string[]) {
    super(`No Gemini model available (${tried.join("; ")})`);
  }
}

/** One request to one model. Resolves to the response text. */
export type CallModel = (
  model: ModelId,
  args: GenerateJsonArgs,
  signal: AbortSignal,
) => Promise<string>;

export type GenerateDeps = {
  call: CallModel;
  budget: ModelBudget;
  now?: () => Date;
  log?: (detail: Record<string, unknown>) => void;
};

const DAY_MS = 86_400_000;

export function createGenerate(deps: GenerateDeps): GenerateJson {
  return async function generate(args) {
    const task = args.task ?? "decide";
    const timeout = AbortSignal.timeout(args.timeoutMs);
    const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
    const tried: string[] = [];

    for (const model of chainFor(task)) {
      const now = deps.now?.() ?? new Date();
      const refusal = await deps.budget.reserve(model, now);
      if (refusal) {
        tried.push(`${model}: ${refusal === "blocked" ? "blocked" : `${refusal} budget used up`}`);
        continue;
      }
      let text: string;
      try {
        text = await deps.call(model, args, signal);
      } catch (err) {
        // Out of time (or the caller gave up): no point in trying another model.
        if (signal.aborted) throw err;
        const status = (err as { status?: number } | null)?.status;
        const message = err instanceof Error ? err.message : "";
        if (status === 429) {
          // Blocked until the quota that ran out resets, so this model is not asked again before.
          const daily = /per\s?day|daily/i.test(message);
          const { minuteEnds, dayEnds } = periods(now);
          await deps.budget.block(
            model,
            daily ? dayEnds : minuteEnds,
            daily ? "429: daily quota used up" : "429: rate limited",
          );
        } else if (status === 404) {
          // A retired (or renamed) model: skip it for a day.
          await deps.budget.block(model, new Date(now.getTime() + DAY_MS), "404: not available");
        } else if (status !== 503 && status !== 500 && status !== 400) {
          throw err;
        }
        tried.push(`${model}: ${status}`);
        deps.log?.({ event: "model_failed", task, model, status });
        continue;
      }
      const parsed: unknown = JSON.parse(text);
      args.onModel?.(model);
      deps.log?.({ event: "answered", task, model });
      return parsed;
    }
    deps.log?.({ event: "no_model", task, tried });
    throw new GeminiUnavailableError(tried);
  };
}

let client: GoogleGenAI | undefined;

const callGemini: CallModel = async (model, args, signal) => {
  const apiKey = env().GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY is not set");
  client ??= new GoogleGenAI({ apiKey });
  const response = await client.models.generateContent({
    model,
    contents: args.prompt,
    config: {
      systemInstruction: args.system,
      responseMimeType: "application/json",
      responseJsonSchema: args.schema,
      temperature: 0.4,
      abortSignal: signal,
      // Keeps latency predictable; these are short extraction and ranking tasks.
      ...(MODELS[model].thinkingLevel
        ? { thinkingConfig: { thinkingLevel: args.thinking ?? ThinkingLevel.LOW } }
        : {}),
    },
  });
  const text = response.text;
  if (!text) throw new Error("Gemini returned no text");
  return text;
};

/** The budgets every server instance shares; also read by /api/health. */
export const geminiBudget: ModelBudget = tigerModelBudget();

export const geminiGenerateJson: GenerateJson = createGenerate({
  call: callGemini,
  budget: geminiBudget,
  log: (detail) => console.log(JSON.stringify({ at: "gemini", ...detail })),
});
