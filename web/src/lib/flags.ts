import { env, type Env } from "./env";

export type SponsorKey =
  "tiger" | "gemini" | "snowflake" | "elevenlabs" | "solana" | "presage" | "ws";

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
  const presageMode = (e.PRESAGE_MODE ?? "mock").toLowerCase();
  return {
    tiger: status(true, !!e.DATABASE_URL),
    gemini: status(true, !!e.GEMINI_API_KEY),
    snowflake: status(
      e.FEATURE_SNOWFLAKE,
      !!(e.SNOWFLAKE_ACCOUNT_URL && e.SNOWFLAKE_PAT && e.SNOWFLAKE_MODEL),
    ),
    elevenlabs: status(e.FEATURE_ELEVENLABS, !!(e.ELEVENLABS_API_KEY && e.ELEVENLABS_VOICE_ID)),
    solana: status(e.FEATURE_SOLANA, !!(e.SOLANA_RPC_URL && e.SOLANA_ATTESTER_SECRET_KEY)),
    presage: status(
      e.FEATURE_PRESAGE,
      presageMode === "sidecar"
        ? !!e.PRESAGE_SIDECAR_URL
        : presageMode === "api"
          ? !!e.PRESAGE_API_KEY
          : false,
    ),
    ws: status(e.FEATURE_WS, !!e.DATABASE_URL),
  };
}

export function isLive(key: SponsorKey): boolean {
  return sponsorStatus()[key].mode === "live";
}
