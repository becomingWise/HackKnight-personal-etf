// The track record's building blocks (docs/API.md section 1f). Gemini is mocked.
import { describe, expect, it, vi } from "vitest";
import type { GenerateJson } from "../sponsors/gemini";
import { BENCHMARK, CLOSE_SYMBOLS, closeRows } from "./closes";
import { CallLimitError, callKey, createCachedCalls, memoryCallStore } from "./replayCalls";

describe("stock closes", () => {
  it("covers the 40 universe tickers and SPY", () => {
    expect(CLOSE_SYMBOLS).toHaveLength(41);
    expect(new Set(CLOSE_SYMBOLS).size).toBe(41);
    expect(CLOSE_SYMBOLS[0]).toBe(BENCHMARK);
  });

  it("turns the price script's output into rows and drops anything unusable", () => {
    const rows = closeRows({
      SPY: { "2026-10-01": 763.99, "2026-10-02": 769.64, "10/03/2026": 770, "2026-10-05": null },
      NVDA: { "2026-10-02": 0, "2026-10-01": "188" },
      ZZZZ: { "2026-10-02": 12 },
      TSM: "oops",
    });
    expect(rows).toEqual([
      { symbol: "SPY", day: "2026-10-01", close: 763.99 },
      { symbol: "SPY", day: "2026-10-02", close: 769.64 },
    ]);
    expect(closeRows(null)).toEqual([]);
    expect(closeRows("[]")).toEqual([]);
  });
});

describe("replay calls", () => {
  const args = { system: "s", prompt: "p", schema: { type: "object" }, timeoutMs: 1000 };
  const model = () =>
    vi.fn<GenerateJson>(async (a) => {
      a.onModel?.("gemini-3.5-flash-lite");
      return { ok: true };
    });

  it("stores every answer, so a second run makes no Gemini call", async () => {
    const store = memoryCallStore();
    const generate = model();
    const first = createCachedCalls({ generate, store, limit: 5 });
    expect(await first.ask("a", args)).toEqual({
      model: "gemini-3.5-flash-lite",
      response: { ok: true },
      cached: false,
    });
    const second = createCachedCalls({ generate, store, limit: 0 });
    expect(await second.ask("a", args)).toMatchObject({ cached: true, response: { ok: true } });
    expect(generate).toHaveBeenCalledTimes(1);
    expect([first.made(), second.made()]).toEqual([1, 0]);
    // Another prompt, schema or model chain is another call.
    expect(callKey(args)).not.toBe(callKey({ ...args, prompt: "q" }));
    expect(callKey({ ...args, task: "voteA" })).not.toBe(callKey({ ...args, task: "voteB" }));
  });

  it("stops at the limit of new calls and paces them", async () => {
    const sleep = vi.fn(async () => {});
    const generate = model();
    const calls = createCachedCalls({
      generate,
      store: memoryCallStore(),
      limit: 2,
      paceMs: 7000,
      sleep,
    });
    await calls.ask("a", { ...args, prompt: "1" });
    await calls.ask("b", { ...args, prompt: "2" });
    await calls.ask("a again", { ...args, prompt: "1" });
    await expect(calls.ask("c", { ...args, prompt: "3" })).rejects.toBeInstanceOf(CallLimitError);
    expect(generate).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls).toEqual([[7000]]);
  });

  it("does not store a failed call", async () => {
    const store = memoryCallStore();
    const failing = createCachedCalls({
      generate: async () => {
        throw new Error("429");
      },
      store,
      limit: 5,
    });
    await expect(failing.ask("a", args)).rejects.toThrow("429");
    expect(await store.get(callKey(args))).toBeNull();
  });
});
