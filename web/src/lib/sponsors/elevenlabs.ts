// ElevenLabs text-to-speech. Live only when FEATURE_ELEVENLABS is on and the key and voice
// are configured (see flags.ts); callers fall back to a script-only answer otherwise.
import { env } from "../env";

export const DEFAULT_ELEVENLABS_MODEL = "eleven_flash_v2_5";
/** 128 kbit/s constant bitrate: 16,000 bytes per second of audio. */
const OUTPUT_FORMAT = "mp3_44100_128";
export const MP3_BYTES_PER_SECOND = 16_000;

export type Speech = {
  audio: Buffer;
  mime: string;
  model: string;
  characterCost: number | null;
};

export type Synthesize = (text: string, signal?: AbortSignal) => Promise<Speech>;

export const elevenLabsModel = () => env().ELEVENLABS_MODEL_ID ?? DEFAULT_ELEVENLABS_MODEL;

/** Throws on a missing key, a timeout or any non-2xx answer. Error messages never contain the key. */
export const synthesize: Synthesize = async (text, signal) => {
  const e = env();
  if (!e.ELEVENLABS_API_KEY || !e.ELEVENLABS_VOICE_ID) {
    throw new Error("ElevenLabs is not configured");
  }
  const model = elevenLabsModel();
  const timeout = AbortSignal.timeout(20_000);
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(e.ELEVENLABS_VOICE_ID)}?output_format=${OUTPUT_FORMAT}`,
    {
      method: "POST",
      headers: {
        "xi-api-key": e.ELEVENLABS_API_KEY,
        "Content-Type": "application/json",
        Accept: "audio/mpeg",
      },
      body: JSON.stringify({ text, model_id: model }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      cache: "no-store",
    },
  );
  if (!res.ok) {
    // The body can echo the voice id; report only the status and ElevenLabs' error code.
    const detail = (await res.json().catch(() => null)) as { detail?: { status?: string } } | null;
    throw new Error(
      `ElevenLabs answered ${res.status}${detail?.detail?.status ? ` (${detail.detail.status})` : ""}`,
    );
  }
  const audio = Buffer.from(await res.arrayBuffer());
  if (audio.length < 1000) throw new Error("ElevenLabs returned no audio");
  const cost = Number(res.headers.get("character-cost"));
  return {
    audio,
    mime: res.headers.get("content-type")?.split(";")[0] || "audio/mpeg",
    model,
    characterCost: Number.isFinite(cost) && cost > 0 ? cost : null,
  };
};
