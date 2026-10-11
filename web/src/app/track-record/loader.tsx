"use client";

// Loads GET /api/track-record (plain SQL over stored decisions; no Gemini call).
import { useEffect, useState } from "react";
import { asFailure, get } from "../client";
import type { TrackRecord } from "../consoleView";
import { plainError } from "../productView";
import { TrackRecordSection } from "../trackRecord";

const BOX = "rounded-panel border border-line bg-surface p-5";

export function TrackRecordLoader() {
  const [track, setTrack] = useState<TrackRecord | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let shown = true;
    get<TrackRecord>("/api/track-record").then(
      (loaded) => shown && setTrack(loaded),
      (err) => shown && setProblem(plainError(asFailure(err), "the track record")),
    );
    return () => {
      shown = false;
    };
  }, []);

  if (problem) {
    return (
      <p role="alert" className={`${BOX} text-down`}>
        {problem}
      </p>
    );
  }
  if (!track) {
    return (
      <p role="status" className={`${BOX} text-muted`}>
        Loading the track record…
      </p>
    );
  }
  if (!track.decisions && !track.pending) {
    return (
      <p className={`${BOX} text-muted`}>
        No decision has been recorded yet. Build a basket and the panel&apos;s call will appear
        here, scored one week later.
      </p>
    );
  }
  return <TrackRecordSection track={track} eyebrow="THE AI PANEL" />;
}
