// POST /api/baskets/{id}/letter: Gemini-written manager's note with cache and fallback.
import { describe, expect, it, vi } from "vitest";
import type { StoredBasket } from "../baskets/store";
import { memoryApiCache } from "../cache/apiCache";
import type { GenerateJson } from "../sponsors/gemini";
import { createLetterHandler, type LetterHandlerDeps } from "./handler";
import { MAX_WORDS, fallbackLetter, numbersAreGrounded, wordCount } from "./letter";

const BASKET: StoredBasket = {
  id: "abcdefgh",
  createdAt: "2026-10-10T10:00:00.000Z",
  idea: "AI chips and Taiwan risk",
  summary: "Chip makers exposed to Taiwan risk.",
  source: "gemini",
  stocks: [
    {
      symbol: "TSM",
      name: "Taiwan Semiconductor",
      reason: "Fabs are in Taiwan.",
      marketId: "1",
      weightPct: 32.75,
    },
    { symbol: "NVDA", name: "NVIDIA", reason: "Export rules.", marketId: "2", weightPct: 37.06 },
    { symbol: "INTC", name: "Intel", reason: "Domestic fabs.", marketId: null, weightPct: 30.19 },
  ],
  weights: {
    status: "adjusted",
    explanation: "Tilted by Polymarket odds moves over the past week.",
    holdings: [],
    evidence: [],
  },
  markets: [
    {
      id: "1",
      title: "Will China invade Taiwan by December 31, 2027?",
      url: "https://polymarket.com/event/a",
      outcome: "Yes",
      probability: 0.105,
      observedAt: "2026-10-10T10:00:00.000Z",
      change7d: null,
      citedBy: ["stocks"],
    },
    {
      id: "2",
      title: "Will AI-chip export licensing become law this year?",
      url: "https://polymarket.com/event/b",
      outcome: "Yes",
      probability: 0.21,
      observedAt: "2026-10-10T10:00:00.000Z",
      change7d: -0.125,
      citedBy: ["stocks", "weights"],
    },
  ],
};

const GOOD =
  "This basket bets that AI chip demand outruns geopolitical risk. NVDA carries the most weight at 37.06%, " +
  "helped by Polymarket giving only 21% to new export licensing becoming law. TSM follows at 32.75%, with the " +
  "market putting a Taiwan invasion at 10.5%. These are event probabilities, not forecasts of returns.";

function api(generate: GenerateJson, over: Partial<LetterHandlerDeps> = {}) {
  const cache = memoryApiCache();
  const handler = createLetterHandler({
    generate,
    baskets: {
      insert: async () => ({ id: "x", createdAt: "" }),
      get: async (id) => (id === BASKET.id ? BASKET : null),
    },
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    cache,
    ...over,
  });
  const post = (id: string, headers: Record<string, string> = {}) =>
    handler.POST(
      new Request(`https://prophetf.vercel.app/api/baskets/${id}/letter`, {
        method: "POST",
        headers,
      }),
      id,
    );
  return { post, cache, handler };
}

describe("POST /api/baskets/{id}/letter", () => {
  it("returns Gemini's letter, then serves it from the cache", async () => {
    const generate = vi.fn(async () => ({ letter: GOOD }));
    const a = api(generate);
    const first = await a.post("abcdefgh", { Origin: "https://becomingwise.github.io" });
    expect(first.status).toBe(200);
    expect(first.headers.get("X-Cache")).toBe("MISS");
    expect(first.headers.get("Access-Control-Allow-Origin")).toBe("https://becomingwise.github.io");
    const body = await first.json();
    expect(body).toEqual({
      id: "abcdefgh",
      letter: GOOD,
      words: wordCount(GOOD),
      source: "gemini",
      generatedAt: expect.any(String),
      cached: false,
      cachedAt: null,
    });
    expect(body.words).toBeLessThanOrEqual(MAX_WORDS);

    const second = await a.post("abcdefgh");
    expect(second.headers.get("X-Cache")).toBe("HIT");
    expect(await second.json()).toMatchObject({
      letter: GOOD,
      cached: true,
      cachedAt: expect.any(String),
    });
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it("gives Gemini the basket's facts and uses the note's model chain", async () => {
    const generate = vi.fn(async () => ({ letter: GOOD }));
    await api(generate).post("abcdefgh");
    const args = (generate.mock.calls as unknown as Parameters<GenerateJson>[])[0][0];
    expect(args.task).toBe("note");
    expect(args.prompt).toContain("AI chips and Taiwan risk");
    expect(args.prompt).toContain("NVDA (NVIDIA): 37.06%");
    expect(args.prompt).toContain('"Will China invade Taiwan by December 31, 2027?": Yes 11%');
    expect(args.system).toContain(`${MAX_WORDS} words`);
  });

  it("retries once when the letter invents a number or is too long, then accepts a good one", async () => {
    const invented = GOOD.replace("21%", "85%");
    for (const bad of [invented, `${GOOD} ${"More words. ".repeat(60)}`]) {
      const generate = vi
        .fn()
        .mockResolvedValueOnce({ letter: bad })
        .mockResolvedValueOnce({ letter: GOOD });
      const body = await (await api(generate).post("abcdefgh")).json();
      expect(body).toMatchObject({ letter: GOOD, source: "gemini" });
      expect(generate).toHaveBeenCalledTimes(2);
      expect(generate.mock.calls[1][0].prompt).toContain("previous letter was rejected");
    }
  });

  it("falls back to a template when Gemini fails, and does not cache it", async () => {
    const generate = vi.fn(async () => {
      throw new Error("429 quota");
    });
    const a = api(generate);
    const body = await (await a.post("abcdefgh")).json();
    expect(body).toMatchObject({ source: "fallback", cached: false });
    expect(body.letter).toContain("NVDA 37.06%");
    expect(body.letter).toContain('"Will China invade Taiwan by December 31, 2027?" at 11%');
    expect(body.words).toBeLessThanOrEqual(MAX_WORDS);
    expect((await a.post("abcdefgh")).headers.get("X-Cache")).toBe("MISS");
  });

  it("retries once after a timeout or error", async () => {
    const generate = vi
      .fn<GenerateJson>()
      .mockRejectedValueOnce(new Error("This operation was aborted"))
      .mockResolvedValueOnce({ letter: GOOD });
    const body = await (await api(generate).post("abcdefgh")).json();
    expect(body).toMatchObject({ letter: GOOD, source: "gemini" });
    const calls = generate.mock.calls as unknown as Parameters<GenerateJson>[];
    expect(calls.map((c) => c[0].task)).toEqual(["note", "note"]);
  });

  it("falls back when Gemini keeps breaking the rules", async () => {
    const generate = vi.fn(async () => ({ letter: GOOD.replace("21%", "85%") }));
    const body = await (await api(generate).post("abcdefgh")).json();
    expect(body.source).toBe("fallback");
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it("404s unknown baskets and 429s limited callers without calling Gemini", async () => {
    const generate = vi.fn(async () => ({ letter: GOOD }));
    expect((await api(generate).post("zzzzzzzz")).status).toBe(404);
    expect((await api(generate).post("nope")).status).toBe(404);
    const limited = await api(generate, {
      rateLimit: async () => ({ allowed: false, retryAfterSeconds: 9 }),
    }).post("abcdefgh");
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("9");
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("letter helpers", () => {
  it("accepts only percentages that are weights or cited odds", () => {
    expect(numbersAreGrounded("NVDA at 37.06% while the market gives 21%.", BASKET)).toBe(true);
    expect(numbersAreGrounded("A 79% chance it does not pass; TSM is 33%.", BASKET)).toBe(true);
    expect(numbersAreGrounded("No numbers at all.", BASKET)).toBe(true);
    expect(numbersAreGrounded("We expect a 12% return.", BASKET)).toBe(false);
  });

  it("writes a template that stays within the limit and handles baskets without markets", () => {
    const bare = {
      ...BASKET,
      url: "u",
      markets: [],
      weights: { ...BASKET.weights, status: "unavailable" as const },
    };
    const text = fallbackLetter(bare);
    expect(text).toContain("keep their starting weights");
    expect(text).not.toContain("Polymarket odds when it was built");
    expect(wordCount(fallbackLetter({ ...BASKET, url: "u" }))).toBeLessThanOrEqual(MAX_WORDS);
    expect(numbersAreGrounded(fallbackLetter({ ...BASKET, url: "u" }), BASKET)).toBe(true);
  });
});
