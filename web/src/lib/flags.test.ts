import { describe, expect, it } from "vitest";
import { parseEnv } from "./env";
import { sponsorStatus } from "./flags";

describe("sponsorStatus", () => {
  it("falls back to mock for every optional sponsor when nothing is set", () => {
    const s = sponsorStatus(parseEnv({}));
    for (const key of ["snowflake", "elevenlabs", "solana", "presage", "ws"] as const) {
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
        FEATURE_SNOWFLAKE: "TRUE",
        SNOWFLAKE_ACCOUNT_URL: "https://a.snowflakecomputing.com",
        SNOWFLAKE_PAT: "p",
        SNOWFLAKE_MODEL: "m",
        FEATURE_PRESAGE: "1",
        PRESAGE_MODE: "sidecar",
        PRESAGE_SIDECAR_URL: "http://localhost:8080",
      }),
    );
    expect(s.tiger.mode).toBe("live");
    expect(s.gemini.mode).toBe("live");
    expect(s.snowflake.mode).toBe("live");
    expect(s.presage.mode).toBe("live");
  });

  it("treats blank values as unset and PRESAGE_MODE=mock as mock", () => {
    const s = sponsorStatus(
      parseEnv({ DATABASE_URL: "  ", FEATURE_PRESAGE: "true", PRESAGE_MODE: "mock" }),
    );
    expect(s.tiger.configured).toBe(false);
    expect(s.presage.mode).toBe("mock");
  });
});
