// POST /api/baskets/{id}/narrate and GET /api/audio/{id}, with ElevenLabs, Gemini and Tiger faked.
import { describe, expect, it, vi } from "vitest";
import type { StoredBasket } from "../baskets/store";
import { memoryApiCache } from "../cache/apiCache";
import type { Synthesize } from "../sponsors/elevenlabs";
import { briefingScript, createNarrateHandlers, type NarrateDeps } from "./handler";
import type { BriefingMeta, BriefingStore } from "./store";

const BASKET: StoredBasket = {
  id: "abcdefgh",
  createdAt: "2026-10-10T10:00:00.000Z",
  idea: "AI chips and Taiwan risk.",
  summary: "s",
  source: "gemini",
  stocks: [
    { symbol: "TSM", name: "Taiwan Semiconductor", reason: "r", marketId: "1", weightPct: 60 },
    { symbol: "NVDA", name: "NVIDIA", reason: "r", marketId: null, weightPct: 40 },
  ],
  weights: { status: "adjusted", explanation: "e", holdings: [], evidence: [] },
  markets: [
    {
      id: "1",
      title: "Will China invade Taiwan?",
      url: "https://polymarket.com/event/a",
      outcome: "Yes",
      probability: 0.105,
      observedAt: "2026-10-10T10:00:00.000Z",
      change7d: null,
      citedBy: ["stocks"],
    },
  ],
};

const LETTER =
  "This basket bets on chip demand despite Taiwan risk. TSM leads at 60% and NVDA holds 40%, " +
  'with the market putting a "Taiwan invasion" at 10.5%. These are event probabilities, not forecasts.';

// 32,000 bytes of fake MP3 = 2 seconds at 128 kbit/s.
const AUDIO = Buffer.alloc(32_000, 7);

function memoryBriefings(): BriefingStore & {
  rows: Map<string, { meta: BriefingMeta; audio: Buffer }>;
} {
  const rows = new Map<string, { meta: BriefingMeta; audio: Buffer }>();
  return {
    rows,
    async meta(id) {
      return rows.get(id)?.meta ?? null;
    },
    async audio(id) {
      const row = rows.get(id);
      return row ? { audio: row.audio, mime: row.meta.mime } : null;
    },
    async put(b) {
      const meta: BriefingMeta = {
        basketId: b.basketId,
        script: b.script,
        mime: b.mime,
        model: b.model,
        bytes: b.audio.length,
        createdAt: "2026-10-10T11:00:00.000Z",
      };
      rows.set(b.basketId, { meta, audio: b.audio });
      return meta;
    },
  };
}

function api(over: Partial<NarrateDeps> = {}) {
  const briefings = memoryBriefings();
  const synthesize = vi.fn<Synthesize>(async () => ({
    audio: AUDIO,
    mime: "audio/mpeg",
    model: "eleven_flash_v2_5",
    characterCost: 350,
  }));
  const generate = vi.fn(async () => ({ letter: LETTER }));
  const handlers = createNarrateHandlers({
    generate,
    baskets: {
      insert: async () => ({ id: "x", createdAt: "" }),
      get: async (id) => (id === BASKET.id ? BASKET : null),
    },
    briefings,
    synthesize,
    live: () => true,
    rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    cache: memoryApiCache(),
    ...over,
  });
  const narrate = (id: string) =>
    handlers.narrate(
      new Request(`https://prophetf.vercel.app/api/baskets/${id}/narrate`, { method: "POST" }),
      id,
    );
  const audio = (id: string, headers: Record<string, string> = {}) =>
    handlers.audio(new Request(`https://prophetf.vercel.app/api/audio/${id}`, { headers }), id);
  return { narrate, audio, briefings, synthesize, generate };
}

describe("POST /api/baskets/{id}/narrate (live)", () => {
  it("narrates the manager's note once and stores the MP3", async () => {
    const a = api();
    const res = await a.narrate("abcdefgh");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      id: "abcdefgh",
      mode: "live",
      script: expect.stringContaining(
        "Here is the ProphETF briefing for your idea: AI chips and Taiwan risk. This basket bets",
      ),
      words: expect.any(Number),
      audioUrl: "https://prophetf.vercel.app/api/audio/abcdefgh",
      mime: "audio/mpeg",
      bytes: 32_000,
      durationSeconds: 2,
      model: "eleven_flash_v2_5",
      generatedAt: "2026-10-10T11:00:00.000Z",
      cached: false,
    });
    // Quotes are removed for speech; ElevenLabs gets exactly the returned script.
    expect(body.script).not.toMatch(/["“”]/);
    expect(a.synthesize).toHaveBeenCalledWith(body.script, expect.anything());

    const again = await (await a.narrate("abcdefgh")).json();
    expect(again).toMatchObject({ mode: "live", cached: true, script: body.script, bytes: 32_000 });
    expect(a.synthesize).toHaveBeenCalledTimes(1);
    expect(a.generate).toHaveBeenCalledTimes(1);
  });

  it("answers with the script alone when ElevenLabs fails, and stores nothing", async () => {
    const a = api({
      synthesize: async () => {
        throw new Error("ElevenLabs answered 401");
      },
    });
    const body = await (await a.narrate("abcdefgh")).json();
    expect(body).toMatchObject({ mode: "mock", audioUrl: null, bytes: null, cached: false });
    expect(body.script).toContain("Taiwan Semiconductor leads at 60%");
    expect(body.note).toMatch(/could not be generated/);
    expect(a.briefings.rows.size).toBe(0);
    expect((await a.audio("abcdefgh")).status).toBe(404);
  });

  it("stops spending when the daily audio budget is used up, but keeps serving stored audio", async () => {
    const calls: string[] = [];
    const a = api({
      rateLimit: async (limits) => {
        calls.push(limits[0].bucket);
        return { allowed: limits[0].bucket !== "narrate:new", retryAfterSeconds: 60 };
      },
    });
    const body = await (await a.narrate("abcdefgh")).json();
    expect(body).toMatchObject({ mode: "mock", audioUrl: null });
    expect(body.note).toMatch(/budget/);
    expect(a.synthesize).not.toHaveBeenCalled();
    expect(calls).toContain("narrate:new");
  });

  it("404s unknown baskets and 429s limited callers", async () => {
    const a = api();
    expect((await a.narrate("zzzzzzzz")).status).toBe(404);
    expect((await a.narrate("nope")).status).toBe(404);
    const limited = api({ rateLimit: async () => ({ allowed: false, retryAfterSeconds: 5 }) });
    expect((await limited.narrate("abcdefgh")).status).toBe(429);
    expect(limited.synthesize).not.toHaveBeenCalled();
  });
});

describe("POST /api/baskets/{id}/narrate (ElevenLabs off)", () => {
  it("returns the script with no audio and never calls ElevenLabs", async () => {
    const a = api({ live: () => false });
    const body = await (await a.narrate("abcdefgh")).json();
    expect(body).toMatchObject({ mode: "mock", audioUrl: null, mime: null, durationSeconds: null });
    expect(body.script).toContain("Here is the ProphETF briefing");
    expect(body.note).toMatch(/switched off/);
    expect(a.synthesize).not.toHaveBeenCalled();
  });
});

describe("GET /api/audio/{id}", () => {
  async function ready() {
    const a = api();
    await a.narrate("abcdefgh");
    return a;
  }

  it("serves the whole MP3 with media headers", async () => {
    const res = await (await ready()).audio("abcdefgh");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("audio/mpeg");
    expect(res.headers.get("Content-Length")).toBe("32000");
    expect(res.headers.get("Accept-Ranges")).toBe("bytes");
    expect(res.headers.get("Cache-Control")).toContain("max-age");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(Buffer.from(await res.arrayBuffer()).equals(AUDIO)).toBe(true);
  });

  it("serves byte ranges, as Safari and seeking players require", async () => {
    const a = await ready();
    const first = await a.audio("abcdefgh", { Range: "bytes=0-1" });
    expect(first.status).toBe(206);
    expect(first.headers.get("Content-Range")).toBe("bytes 0-1/32000");
    expect(first.headers.get("Content-Length")).toBe("2");

    const open = await a.audio("abcdefgh", { Range: "bytes=31000-" });
    expect(open.headers.get("Content-Range")).toBe("bytes 31000-31999/32000");
    expect((await open.arrayBuffer()).byteLength).toBe(1000);

    const suffix = await a.audio("abcdefgh", { Range: "bytes=-500" });
    expect(suffix.headers.get("Content-Range")).toBe("bytes 31500-31999/32000");

    const beyond = await a.audio("abcdefgh", { Range: "bytes=40000-" });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get("Content-Range")).toBe("bytes */32000");
  });

  it("404s when there is no briefing", async () => {
    const a = api();
    expect((await a.audio("abcdefgh")).status).toBe(404);
    expect((await a.audio("../secret")).status).toBe(404);
  });
});

describe("briefingScript", () => {
  it("speaks company names instead of tickers and rounds weights, keeping small odds", () => {
    const script = briefingScript(
      "chips",
      "NVDA leads at 27.49%, then TSM at 22.12%. A 3.6% chance of a blockade; AMD is not NVDAX.",
      [
        { symbol: "NVDA", name: "NVIDIA" },
        { symbol: "TSM", name: "Taiwan Semiconductor" },
      ],
    );
    expect(script).toBe(
      "Here is the ProphETF briefing for your idea: chips. NVIDIA leads at 27%, then Taiwan Semiconductor at 22%. A 3.6% chance of a blockade; AMD is not NVDAX.",
    );
  });

  it("adds a spoken intro, drops quotes and tidies whitespace", () => {
    expect(briefingScript(" Crypto regulation?! ", 'A “quoted”\n\n"letter".')).toBe(
      "Here is the ProphETF briefing for your idea: Crypto regulation. A quoted letter.",
    );
  });
});
