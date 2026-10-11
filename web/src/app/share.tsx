"use client";

// Save & share and Listen. Nothing here runs on a page view: a basket is saved, its manager's
// note written (POST /api/baskets/{id}/letter) and its briefing made (POST .../narrate, ElevenLabs)
// only when the visitor presses the button. A basket never changes, so each is made once.
import { useState } from "react";
import { asFailure, post } from "./client";
import {
  plainError,
  saveBody,
  sharePath,
  type Letter,
  type Narration,
  type SavedBasket,
  type Stocks,
  type Weights,
} from "./productView";

const BUTTON =
  "rounded-full border border-blue px-4 py-2 text-sm font-semibold text-blue hover:bg-blue-soft disabled:opacity-50";

type Listening =
  | { state: "idle" | "loading" }
  | { state: "ready"; narration: Narration }
  | { state: "error"; message: string };

/** The audio briefing of a saved basket, made the first time someone presses Listen. */
export function Listen({ id }: { id: string }) {
  const [listening, setListening] = useState<Listening>({ state: "idle" });

  async function listen() {
    setListening({ state: "loading" });
    try {
      const narration = await post<Narration>(`/api/baskets/${id}/narrate`);
      setListening({ state: "ready", narration });
    } catch (err) {
      setListening({ state: "error", message: plainError(asFailure(err), "the briefing") });
    }
  }

  if (listening.state === "ready") {
    const { narration } = listening;
    return narration.mode === "live" && narration.audioUrl ? (
      <div className="grid gap-1">
        {/* Same origin on purpose: the stored MP3 of this basket. */}
        <audio controls autoPlay src={`/api/audio/${id}`} className="w-full max-w-md">
          Your browser cannot play this audio.
        </audio>
        <p className="text-xs text-muted">
          Read aloud by ElevenLabs
          {narration.durationSeconds ? ` · about ${narration.durationSeconds} seconds` : ""}.
        </p>
      </div>
    ) : (
      <div className="grid gap-1 text-sm">
        <p className="text-muted">
          The audio is not available right now. Here is the briefing as text:
        </p>
        <p className="whitespace-pre-line">{narration.script}</p>
      </div>
    );
  }
  return (
    <div className="grid gap-1">
      <p>
        <button
          type="button"
          className={BUTTON}
          onClick={listen}
          disabled={listening.state === "loading"}
        >
          {listening.state === "loading" ? "Making the briefing…" : "▶ Listen to the briefing"}
        </button>
      </p>
      {listening.state === "error" && (
        <p role="alert" className="text-sm text-down">
          {listening.message}
        </p>
      )}
    </div>
  );
}

type Saving =
  | { state: "idle" | "saving" }
  | { state: "saved"; basket: SavedBasket; letter: Letter | null }
  | { state: "error"; message: string };

export function SaveShare(props: { idea: string; stocks: Stocks; weights: Weights | null }) {
  const [saving, setSaving] = useState<Saving>({ state: "idle" });
  const [copied, setCopied] = useState(false);

  async function save() {
    setSaving({ state: "saving" });
    try {
      const basket = await post<SavedBasket>(
        "/api/baskets",
        saveBody(props.idea, props.stocks, props.weights),
      );
      // The note is written once per basket; when it cannot be, the basket is still saved.
      const letter = await post<Letter>(`/api/baskets/${basket.id}/letter`).catch(() => null);
      setSaving({ state: "saved", basket, letter });
    } catch (err) {
      setSaving({ state: "error", message: plainError(asFailure(err), "saving the basket") });
    }
  }

  if (saving.state !== "saved") {
    return (
      <div className="grid gap-1">
        <p>
          <button
            type="button"
            className={BUTTON}
            onClick={save}
            disabled={saving.state === "saving"}
          >
            {saving.state === "saving" ? "Saving…" : "Save & share"}
          </button>
        </p>
        {saving.state === "error" && (
          <p role="alert" className="text-sm text-down">
            {saving.message}
          </p>
        )}
      </div>
    );
  }

  const path = sharePath(saving.basket);
  const address = path && typeof window !== "undefined" ? `${window.location.origin}${path}` : path;
  return (
    <div className="grid w-full gap-3 rounded-xl border border-line p-4" role="status">
      <p className="font-semibold">Saved. Anyone with this link can see the basket:</p>
      {path && address && (
        <p className="flex flex-wrap items-center gap-2 text-sm">
          <a href={path} className="font-mono break-all text-blue underline">
            {address}
          </a>
          <button
            type="button"
            className="rounded-full border border-line px-3 py-1 text-xs font-medium hover:border-blue hover:text-blue"
            onClick={() => {
              void navigator.clipboard?.writeText(address).then(
                () => setCopied(true),
                () => setCopied(false),
              );
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </button>
        </p>
      )}
      <div className="grid gap-1">
        <p className="text-xs font-semibold tracking-[0.18em] text-blue">MANAGER&apos;S NOTE</p>
        {saving.letter ? (
          <p className="text-sm whitespace-pre-line">{saving.letter.letter}</p>
        ) : (
          <p className="text-sm text-muted">
            The note could not be written right now. The basket is saved all the same.
          </p>
        )}
      </div>
      <Listen id={saving.basket.id} />
    </div>
  );
}
