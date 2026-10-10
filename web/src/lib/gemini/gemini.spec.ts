// The model fallback chain and the per-model budgets, with the Gemini API mocked.
import { describe, expect, it, vi } from "vitest";
import {
  GeminiUnavailableError,
  createGenerate,
  type CallModel,
  type GenerateJsonArgs,
} from "../sponsors/gemini";
import { memoryModelBudget } from "./budget";
import { CHAINS, MODELS, budgetOf, chainFor, periods, type ModelId } from "./models";

const NOW = new Date("2026-10-10T18:30:20Z"); // 11:30 in California

const args = (over: Partial<GenerateJsonArgs> = {}): GenerateJsonArgs => ({
  system: "s",
  prompt: "p",
  schema: {},
  timeoutMs: 5000,
  ...over,
});

const apiError = (status: number, message = "") => Object.assign(new Error(message), { status });

/** A Gemini mock: each model answers with JSON, or with the error set for it. */
function api(errors: Partial<Record<ModelId, Error>> = {}) {
  const call = vi.fn<CallModel>(async (model) => {
    const error = errors[model];
    if (error) throw error;
    return JSON.stringify({ from: model });
  });
  return call;
}

function setup(errors: Partial<Record<ModelId, Error>> = {}) {
  let now = NOW;
  const budget = memoryModelBudget();
  const call = api(errors);
  const log = vi.fn();
  const generate = createGenerate({ call, budget, now: () => now, log });
  return {
    generate,
    call,
    budget,
    log,
    models: () => call.mock.calls.map((c) => c[0]),
    advance: (seconds: number) => (now = new Date(now.getTime() + seconds * 1000)),
    at: () => now,
  };
}

describe("model chains", () => {
  it("uses the API's own model ids, Flash-Lite first for the workflow and Flash first for the note", () => {
    expect(CHAINS.decide).toEqual([
      "gemini-3.5-flash-lite",
      "gemini-3.1-flash-lite",
      "gemini-2.5-flash-lite",
    ]);
    expect(CHAINS.plan).toEqual(CHAINS.decide);
    expect(CHAINS.note).toEqual([
      "gemini-3.8-flash",
      "gemini-3-flash-preview",
      "gemini-3.6-flash",
      "gemini-3.5-flash",
      "gemini-3.5-flash-lite",
      "gemini-2.5-flash",
      "gemini-2.5-flash-lite",
    ]);
    // The retiring models are never first and always last.
    for (const chain of Object.values(CHAINS)) {
      const retiring = chain.map((m) => "retiring" in MODELS[m]);
      expect(retiring[0]).toBe(false);
      // The voting chains have no retiring model at all.
      if (!retiring.includes(true)) continue;
      expect(retiring.indexOf(true)).toBe(retiring.lastIndexOf(false) + 1);
    }
    expect(chainFor("decide", "gemini-3.1-flash-lite")[0]).toBe("gemini-3.1-flash-lite");
    expect(chainFor("decide", "not-a-model")).toEqual(CHAINS.decide);
  });

  it("stays 20% under every limit", () => {
    expect(budgetOf("gemini-3.5-flash-lite")).toEqual({ perMinute: 12, perDay: 400 });
    expect(budgetOf("gemini-3.8-flash")).toEqual({ perMinute: 4, perDay: 16 });
    expect(budgetOf("gemini-2.5-flash-lite")).toEqual({ perMinute: 8, perDay: 16 });
  });

  it("counts the day in Pacific time, like Google's quota", () => {
    const p = periods(new Date("2026-10-11T06:59:30Z")); // 23:59:30 on the 10th in California
    expect(p.day).toBe("d:2026-10-10");
    expect(p.minute).toBe("m:2026-10-11T06:59");
    expect(p.dayEnds.toISOString()).toBe("2026-10-11T07:00:00.000Z");
    expect(periods(new Date("2026-10-11T07:00:00Z")).day).toBe("d:2026-10-11");
  });
});

describe("generate with fallback", () => {
  it("answers with the first model and reports which one", async () => {
    const s = setup();
    const onModel = vi.fn();
    expect(await s.generate(args({ task: "plan", onModel }))).toEqual({
      from: "gemini-3.5-flash-lite",
    });
    expect(onModel).toHaveBeenCalledWith("gemini-3.5-flash-lite");
    expect(s.log).toHaveBeenCalledWith({
      event: "answered",
      task: "plan",
      model: "gemini-3.5-flash-lite",
    });
  });

  it("moves down the chain on 429 and does not ask that model again in the same minute", async () => {
    const s = setup({ "gemini-3.5-flash-lite": apiError(429, "Quota exceeded ... PerMinute") });
    expect(await s.generate(args())).toEqual({ from: "gemini-3.1-flash-lite" });
    expect(s.models()).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);

    await s.generate(args());
    expect(s.models().slice(2)).toEqual(["gemini-3.1-flash-lite"]); // the first model was skipped

    s.advance(60);
    await s.generate(args());
    expect(s.models().slice(3)).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  });

  it("blocks a model until the Pacific day ends when its daily quota is gone", async () => {
    const s = setup({
      "gemini-3.5-flash-lite": apiError(429, "GenerateRequestsPerDayPerProjectPerModel-FreeTier"),
    });
    await s.generate(args());
    const usage = await s.budget.usage(s.at());
    expect(usage.find((u) => u.model === "gemini-3.5-flash-lite")).toMatchObject({
      blockedUntil: "2026-10-11T07:00:00.000Z",
      blockedBecause: "429: daily quota used up",
    });
    s.advance(3600);
    await s.generate(args());
    expect(s.models().slice(2)).toEqual(["gemini-3.1-flash-lite"]);
  });

  it("skips a retired model for a day after a 404", async () => {
    const s = setup({
      "gemini-3.5-flash-lite": apiError(503),
      "gemini-3.1-flash-lite": apiError(503),
      "gemini-2.5-flash-lite": apiError(404, "model not found"),
    });
    await expect(s.generate(args())).rejects.toBeInstanceOf(GeminiUnavailableError);
    s.advance(120);
    await expect(s.generate(args())).rejects.toBeInstanceOf(GeminiUnavailableError);
    // 503 is not remembered, so the two live models were tried again; the retired one was not.
    expect(s.models().slice(3)).toEqual(["gemini-3.5-flash-lite", "gemini-3.1-flash-lite"]);
  });

  it("switches models when a per-minute budget is used up, without calling Google", async () => {
    const s = setup();
    for (let i = 0; i < 12; i++) await s.generate(args());
    expect(new Set(s.models())).toEqual(new Set(["gemini-3.5-flash-lite"]));
    await s.generate(args());
    expect(s.models().at(-1)).toBe("gemini-3.1-flash-lite");
    expect(s.call).toHaveBeenCalledTimes(13);
  });

  it("throws GeminiUnavailableError when every model is over budget, and says why", async () => {
    const s = setup();
    // 12 + 12 + 8 calls fit into one minute across the chain.
    for (let i = 0; i < 32; i++) await s.generate(args());
    const error = await s.generate(args()).catch((e: GeminiUnavailableError) => e);
    expect(error).toBeInstanceOf(GeminiUnavailableError);
    expect((error as GeminiUnavailableError).tried).toEqual([
      "gemini-3.5-flash-lite: minute budget used up",
      "gemini-3.1-flash-lite: minute budget used up",
      "gemini-2.5-flash-lite: minute budget used up",
    ]);
    expect(s.call).toHaveBeenCalledTimes(32);
  });

  it("reports what is left of each model's day", async () => {
    const s = setup();
    for (let i = 0; i < 3; i++) await s.generate(args({ task: "note" }));
    const usage = await s.budget.usage(s.at());
    expect(usage.find((u) => u.model === "gemini-3.8-flash")).toEqual({
      model: "gemini-3.8-flash",
      usedToday: 3,
      dailyBudget: 16,
      remainingToday: 13,
      limitPerDay: 20,
      blockedUntil: null,
      blockedBecause: null,
    });
    expect(usage).toHaveLength(Object.keys(MODELS).length);
  });

  it("walks the note's chain through the Flash models before the lighter one", async () => {
    const down = apiError(429, "per day");
    const s = setup({
      "gemini-3.8-flash": down,
      "gemini-3-flash-preview": down,
      "gemini-3.6-flash": down,
      "gemini-3.5-flash": down,
    });
    expect(await s.generate(args({ task: "note" }))).toEqual({ from: "gemini-3.5-flash-lite" });
    expect(s.models()).toHaveLength(5);
  });

  it("does not try another model once the time is up", async () => {
    const budget = memoryModelBudget();
    const call = vi.fn<CallModel>(
      (_model, _args, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const generate = createGenerate({ call, budget });
    await expect(generate(args({ timeoutMs: 20 }))).rejects.toThrow("aborted");
    expect(call).toHaveBeenCalledTimes(1);
  });
});
