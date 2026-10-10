// GET /api/savings and its counters (docs/API.md section 1e), with a mocked clock.
import { describe, expect, it } from "vitest";
import { oddsMovedHeader } from "../cache/apiCache";
import { createSavingsHandler } from "./handler";
import { memorySavings, summarize } from "./store";

const get = () => new Request("https://prophetf.vercel.app/api/savings");

describe("the savings counters", () => {
  it("counts answers served, new and reused, per Pacific day", async () => {
    const calls: Record<string, number> = { "d:2026-10-10": 14, "d:2026-10-11": 2 };
    const store = memorySavings((day) => calls[day] ?? 0);
    // 23:30 in California on October 10 is already October 11 in UTC.
    const evening = new Date("2026-10-11T06:30:00Z");
    await store.record("stocks", false, evening);
    await store.record("stocks", true, evening);
    await store.record("votes", false, evening);
    await store.record("votes", true, evening);
    await store.record("votes", true, evening);
    expect(await store.read(evening)).toEqual({
      day: "2026-10-10",
      answers: 5,
      newAnswers: 2,
      reused: 3,
      reusedPct: 60,
      geminiCalls: 14,
    });

    // After midnight Pacific a new day starts from zero.
    const nextDay = new Date("2026-10-11T07:00:01Z");
    expect(await store.read(nextDay)).toEqual({
      day: "2026-10-11",
      answers: 0,
      newAnswers: 0,
      reused: 0,
      reusedPct: 0,
      geminiCalls: 2,
    });
    await store.record("stocks", true, nextDay);
    expect(await store.read(nextDay)).toMatchObject({ answers: 1, reused: 1, reusedPct: 100 });
    expect((await store.read(evening)).answers).toBe(5);
  });

  it("rounds the reused share to one decimal", () => {
    expect(summarize("d:2026-10-10", { answers: 3, reused: 1 }, 7)).toEqual({
      day: "2026-10-10",
      answers: 3,
      newAnswers: 2,
      reused: 1,
      reusedPct: 33.3,
      geminiCalls: 7,
    });
  });

  it("formats X-Odds-Moved in points, and leaves it out when there is nothing to compare", () => {
    expect(oddsMovedHeader(2.94)).toEqual({ "X-Odds-Moved": "2.9" });
    expect(oddsMovedHeader(0)).toEqual({ "X-Odds-Moved": "0" });
    expect(oddsMovedHeader(null)).toEqual({});
    expect(oddsMovedHeader(undefined)).toEqual({});
  });
});

describe("GET /api/savings", () => {
  it("returns { day, answers, newAnswers, reused, reusedPct, geminiCalls }", async () => {
    const now = new Date("2026-10-10T19:00:00Z");
    const store = memorySavings(() => 9);
    await store.record("stocks", false, now);
    await store.record("stocks", true, now);
    const { GET } = createSavingsHandler({ store, now: () => now });
    const response = await GET(get());
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(Object.keys(body)).toEqual([
      "day",
      "answers",
      "newAnswers",
      "reused",
      "reusedPct",
      "geminiCalls",
    ]);
    expect(body).toMatchObject({ day: "2026-10-10", answers: 2, reused: 1, reusedPct: 50 });
  });

  it("answers 503 when the counters cannot be read", async () => {
    const { GET } = createSavingsHandler({
      store: {
        record: async () => {},
        read: async () => {
          throw new Error("db down");
        },
      },
    });
    const response = await GET(get());
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe("storage_error");
  });
});
