// Parity with the reference Python service (/backend). The fixture holds its real answers,
// produced by `pnpm parity:weights` (scripts/gen-weights-parity.py). If these fail after the
// Python engine changed: mirror the change in engine.ts / adjustWeights.ts, regenerate, rerun.
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { type WeightsResponse } from "./adjustWeights";
import { formatFixed, roundHalfEven, roundWeights, type Signal } from "./engine";
import { createWeightsHandler } from "./handler";
import fixture from "./parity.fixture.json";

const signals = fixture.signals as unknown as Signal[];
const { POST } = createWeightsHandler({
  signals: async () => signals,
  rateLimit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
});

const post = (body: unknown) =>
  POST(
    new Request("https://api.test/api/weights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

type Case = (typeof fixture.cases)[number];
const label = (c: Case) =>
  `${c.status} ${(c.request.holdings ?? []).map((h) => `${h.symbol}:${h.weightPct}`).join(" ") || "(no holdings)"}`;

describe("POST /api/weights matches the Python reference", () => {
  const answered = fixture.cases.filter((c) => c.status === 200);
  const rejected = fixture.cases.filter((c) => c.status !== 200);

  it("has a meaningful fixture", () => {
    expect(answered.length).toBeGreaterThan(60);
    expect(rejected.length).toBeGreaterThan(5);
    expect(answered.some((c) => c.response!.status === "adjusted")).toBe(true);
    expect(answered.some((c) => c.response!.status === "unchanged")).toBe(true);
  });

  it.each(answered.map((c) => [label(c), c] as const))("%s", async (_name, c) => {
    const res = await post(c.request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as WeightsResponse;
    const expected = c.response!;

    expect(body.status).toBe(expected.status);
    // Weights are rounded to 0.01 by both services, so they must be identical.
    expect(body.holdings).toEqual(expected.holdings);
    expect(body.explanation).toBe(expected.explanation);
    expect(body.evidence.map((e) => ({ ...e, observedAt: "<observedAt>" }))).toEqual(
      expected.evidence,
    );
    for (const e of body.evidence) expect(Number.isFinite(Date.parse(e.observedAt))).toBe(true);
  });

  it.each(rejected.map((c) => [label(c), c] as const))(
    "rejects like Python: %s",
    async (_name, c) => {
      const res = await post(c.request);
      expect(res.status).toBe(c.status);
      const body = await res.json();
      // Messages raised by the endpoint itself are identical; schema messages may differ.
      if (c.detail) expect(body.detail).toBe(c.detail);
      expect(body.error.code).toBe("invalid_request");
    },
  );
});

describe("engine helpers match Python", () => {
  it.each(fixture.roundWeights.map((c, i) => [i, c] as const))("round_weights case %i", (_i, c) => {
    const rounded = roundWeights(c.weights);
    expect(rounded).toEqual(c.rounded);
    expect(Math.round(rounded.reduce((a, b) => a + b, 0) * 100)).toBe(10000);
  });

  it.each(fixture.formats.map((f) => [f.x, f] as const))("formats %d like Python", (_x, f) => {
    expect(formatFixed(f.x, 0)).toBe(f.f0);
    expect(formatFixed(f.x, 1)).toBe(f.f1);
    expect(roundHalfEven(f.x)).toBe(f.round);
  });
});

describe("the team's validateAdjustment accepts every answer", () => {
  const controllerPath = path.resolve(process.cwd(), "..", "js", "controller.js");

  it.skipIf(!existsSync(controllerPath))("for all answered parity cases", async () => {
    const { validateAdjustment } = await import(
      /* @vite-ignore */ pathToFileURL(controllerPath).href
    );
    let checked = 0;
    for (const c of fixture.cases.filter((x) => x.status === 200)) {
      const baseline = c.request.holdings!;
      const body = await (await post(c.request)).json();
      const validated = validateAdjustment(body, baseline);
      expect(validated.status).toBe(body.status);
      expect(validated.holdings.map((h: { symbol: string }) => h.symbol)).toEqual(
        baseline.map((h) => h.symbol),
      );
      checked++;
    }
    expect(checked).toBeGreaterThan(60);
  });
});
