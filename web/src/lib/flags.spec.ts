import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";
import { sponsorStatus } from "./flags";

describe("sponsorStatus", () => {
  it("falls back to mock for every optional sponsor when nothing is set", () => {
    const s = sponsorStatus(parseEnv({}));
    for (const key of ["elevenlabs", "ws"] as const) {
      expect(s[key].mode).toBe("mock");
    }
    expect(s.tiger).toEqual({ enabled: true, configured: false, mode: "mock" });
  });

  it("stays on the mock when the flag is on but credentials are missing", () => {
    const s = sponsorStatus(parseEnv({ FEATURE_ELEVENLABS: "true", ELEVENLABS_API_KEY: "k" }));
    expect(s.elevenlabs).toEqual({ enabled: true, configured: false, mode: "mock" });
  });

  it("stays on the mock when credentials exist but the flag is off", () => {
    const s = sponsorStatus(
      parseEnv({ FEATURE_ELEVENLABS: "false", ELEVENLABS_API_KEY: "k", ELEVENLABS_VOICE_ID: "v" }),
    );
    expect(s.elevenlabs.mode).toBe("mock");
  });

  it("goes live when the flag is on and credentials are present", () => {
    const s = sponsorStatus(
      parseEnv({
        DATABASE_URL: "postgres://x",
        GEMINI_API_KEY: "g",
        FEATURE_ELEVENLABS: "TRUE",
        ELEVENLABS_API_KEY: "k",
        ELEVENLABS_VOICE_ID: "v",
      }),
    );
    expect(s.tiger.mode).toBe("live");
    expect(s.gemini.mode).toBe("live");
    expect(s.elevenlabs.mode).toBe("live");
    // Snowflake, Solana and Presage were dropped: their flags are ignored and they are not reported.
    const dropped = sponsorStatus(
      parseEnv({ FEATURE_SNOWFLAKE: "true", FEATURE_SOLANA: "true", FEATURE_PRESAGE: "true" }),
    );
    for (const key of ["snowflake", "solana", "presage"]) expect(dropped).not.toHaveProperty(key);
  });

  it("treats blank values as unset", () => {
    const s = sponsorStatus(parseEnv({ DATABASE_URL: "  " }));
    expect(s.tiger.configured).toBe(false);
  });
});
