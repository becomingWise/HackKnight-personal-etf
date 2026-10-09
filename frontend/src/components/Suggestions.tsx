"use client";

import type { Suggestion, Window } from "@/lib/api";
import { pts, sectorColor, WINDOW_LABEL } from "@/lib/format";

export default function Suggestions({
  suggestions,
  window,
  onAdd,
}: {
  suggestions: Suggestion[];
  window: Window;
  onAdd: (sector: string) => void;
}) {
  if (suggestions.length === 0) return null;
  return (
    <div className="mt-6 rounded-2xl border border-brand/30 bg-gradient-to-r from-brand/10 via-panel/60 to-brand-2/10 p-4">
      <p className="text-xs uppercase tracking-wider text-brand-2">Polymarket is moving outside your scope</p>
      <div className="mt-3 grid gap-3 md:grid-cols-3">
        {suggestions.map((s) => (
          <div key={s.sector} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-panel/80 p-3">
            <div className="min-w-0">
              <p className="flex items-center gap-2 text-sm font-medium">
                <span className="h-2 w-2 rounded-full" style={{ background: sectorColor(s.sector) }} />
                {s.name}
                <span className="num text-xs text-muted">~{(s.score * 100).toFixed(0)}% tilt</span>
              </p>
              <p className="truncate text-xs text-muted">
                {s.driver_label}{" "}
                <span className="num">
                  {pts(s.driver_delta, 0)} / {WINDOW_LABEL[window]}
                </span>
              </p>
            </div>
            <button
              onClick={() => onAdd(s.sector)}
              className="shrink-0 rounded-lg bg-text px-2.5 py-1 text-xs font-medium text-ink hover:bg-white"
            >
              + Add
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
