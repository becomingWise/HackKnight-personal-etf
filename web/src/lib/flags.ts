import { env, type Env } from "./env";

// Solana and Presage were dropped on 2026-10-10 (Snowflake the day before): their flags are
// ignored and they are not reported anywhere.
export type SponsorKey = "tiger" | "gemini" | "elevenlabs" | "ws";

export type SponsorStatus = {
  /** The feature flag is on (core integrations are always on). */
  enabled: boolean;
  /** Every credential the live integration needs is present. */
  configured: boolean;
  /** What the app actually uses: live only when enabled and configured. */
  mode: "live" | "mock";
};

function status(enabled: boolean, configured: boolean): SponsorStatus {
  return { enabled, configured, mode: enabled && configured ? "live" : "mock" };
}

/** One status per sponsor integration. Contains no secret values, safe to return from an API. */
export function sponsorStatus(e: Env = env()): Record<SponsorKey, SponsorStatus> {
  return {
    tiger: status(true, !!e.DATABASE_URL),
    gemini: status(true, !!e.GEMINI_API_KEY),
    elevenlabs: status(e.FEATURE_ELEVENLABS, !!(e.ELEVENLABS_API_KEY && e.ELEVENLABS_VOICE_ID)),
    ws: status(e.FEATURE_WS, !!e.DATABASE_URL),
  };
}

export function isLive(key: SponsorKey): boolean {
  return sponsorStatus()[key].mode === "live";
}
