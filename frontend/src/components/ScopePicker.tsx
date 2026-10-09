"use client";

import type { Sector } from "@/lib/api";
import { sectorColor } from "@/lib/format";

export default function ScopePicker({
  sectors,
  scope,
  onChange,
}: {
  sectors: Sector[];
  scope: string[];
  onChange: (scope: string[]) => void;
}) {
  const toggle = (id: string) =>
    onChange(scope.includes(id) ? scope.filter((s) => s !== id) : [...scope, id]);

  return (
    <div>
      <p className="mb-2 text-xs uppercase tracking-wider text-dim">Your scope</p>
      <div className="flex flex-wrap gap-2">
        {sectors.map((s) => {
          const on = scope.includes(s.id);
          return (
            <button
              key={s.id}
              onClick={() => toggle(s.id)}
              title={`${s.blurb} ${s.holdings.map((h) => h.symbol).join(" · ")}`}
              aria-pressed={on}
              className={`group flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-sm transition ${
                on ? "border-transparent text-text" : "border-line text-muted hover:border-line-2 hover:text-text"
              }`}
              style={on ? { background: sectorColor(s.id, 0, 0.18), boxShadow: `inset 0 0 0 1px ${sectorColor(s.id, 0, 0.6)}` } : undefined}
            >
              <span className="h-2 w-2 rounded-full" style={{ background: sectorColor(s.id) }} />
              {s.name}
              <span className="num text-xs text-dim">{s.holdings.length}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
