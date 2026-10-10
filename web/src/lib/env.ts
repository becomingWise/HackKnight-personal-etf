import { z } from "zod";

const optional = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== "" ? v.trim() : undefined));

const flag = z
  .string()
  .optional()
  .transform((v) => ["1", "true", "on", "yes"].includes((v ?? "").trim().toLowerCase()));

const schema = z.object({
  DATABASE_URL: optional,
  GEMINI_API_KEY: optional,
  CRON_SECRET: optional,
  APP_BASE_URL: optional,

  // Decision workflow (src/lib/pipeline): which analyst writes the evidence packet
  // (mock | module | tiger, default mock) and whether the checker adds an LLM review.
  ANALYST_MODE: optional,
  CHECKER_LLM: flag,
  // A model id from src/lib/gemini/models.ts to try first for decisions; empty = the default chain.
  DECIDER_MODEL: optional,

  // Snowflake was dropped (2026-10-09); the variable stays false and nothing reads it.
  FEATURE_SNOWFLAKE: flag,
  FEATURE_ELEVENLABS: flag,
  // Solana and Presage were dropped (2026-10-10); their variables stay off and nothing reads them.
  FEATURE_SOLANA: flag,
  FEATURE_PRESAGE: flag,
  FEATURE_WS: flag,

  ELEVENLABS_API_KEY: optional,
  ELEVENLABS_VOICE_ID: optional,
  ELEVENLABS_MODEL_ID: optional,

  SOLANA_RPC_URL: optional,
  SOLANA_ATTESTER_SECRET_KEY: optional,
  NEXT_PUBLIC_SOLANA_CLUSTER: optional,

  PRESAGE_API_KEY: optional,
  PRESAGE_MODE: optional,
  PRESAGE_SIDECAR_URL: optional,
});

export type Env = z.infer<typeof schema>;

export function parseEnv(source: Record<string, string | undefined>): Env {
  return schema.parse(source);
}

let cached: Env | undefined;

/** Server-side environment, parsed once. Never import this from client components. */
export function env(): Env {
  cached ??= parseEnv(process.env);
  return cached;
}
