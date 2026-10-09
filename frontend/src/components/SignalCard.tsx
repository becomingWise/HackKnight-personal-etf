"use client";

import { useEffect, useState } from "react";
import { Line, LineChart, ResponsiveContainer, YAxis } from "recharts";
import { api, type Signal, type Window } from "@/lib/api";
import { compactUsd, pts, WINDOW_LABEL } from "@/lib/format";

export default function SignalCard({
  signal,
  window,
  override,
  onOverride,
}: {
  signal: Signal;
  window: Window;
  override?: number;
  onOverride: (p: number | undefined) => void;
}) {
  const [history, setHistory] = useState<{ t: number; p: number }[]>([]);
  useEffect(() => {
    if (signal.status !== "live") return;
    api.history(signal.id, window).then((r) => setHistory(r.history)).catch(() => setHistory([]));
  }, [signal.id, signal.status, window]);

  if (signal.status !== "live" || !signal.move) {
    return (
      <div className="rounded-xl border border-dashed border-line p-4 text-sm text-dim">
        {signal.label} — no live market right now
      </div>
    );
  }

  const { move } = signal;
  const delta = move.delta;
  const editing = override !== undefined;
  const betas = Object.entries(signal.betas).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  const color = delta > 0.001 ? "var(--color-up)" : delta < -0.001 ? "var(--color-down)" : "var(--color-muted)";

  return (
    <div className={`rounded-xl border bg-panel-2 p-4 transition ${editing ? "border-brand/60" : "border-line"}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-medium">{signal.label}</p>
          <a
            href={signal.url}
            target="_blank"
            rel="noreferrer"
            className="block truncate text-xs text-muted hover:text-brand-2"
            title={signal.question}
          >
            {signal.question} ↗
          </a>
        </div>
        <div className="text-right">
          <p className="num text-xl font-semibold">{(move.now * 100).toFixed(1)}%</p>
          <p className="num text-xs" style={{ color }}>
            {pts(delta)} {editing ? "vs ref" : WINDOW_LABEL[window]}
          </p>
        </div>
      </div>

      <div className="mt-3 h-12">
        {history.length > 1 && (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={history}>
              <YAxis hide domain={["dataMin - 0.01", "dataMax + 0.01"]} />
              <Line type="monotone" dataKey="p" dot={false} stroke={color} strokeWidth={1.5} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      <div className="mt-3 flex items-center gap-3">
        <span className="text-xs text-dim">What if</span>
        <input
          type="range"
          min={0}
          max={100}
          step={1}
          value={Math.round((override ?? move.live) * 100)}
          onChange={(e) => onOverride(Number(e.target.value) / 100)}
          className="flex-1"
          aria-label={`What-if probability for ${signal.label}`}
        />
        {editing ? (
          <button onClick={() => onOverride(undefined)} className="text-xs text-brand-2 hover:underline">
            live {(move.live * 100).toFixed(0)}%
          </button>
        ) : (
          <span className="num text-xs text-dim">{signal.volume ? compactUsd(signal.volume) : ""} vol</span>
        )}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {betas.map(([sym, b]) => (
          <span
            key={sym}
            className={`num rounded-md px-1.5 py-0.5 text-[11px] ${b > 0 ? "bg-up/10 text-up" : "bg-down/10 text-down"}`}
            title={`${sym} moves ${b > 0 ? "with" : "against"} this event (β ${b})`}
          >
            {sym} {b > 0 ? "+" : "−"}
            {Math.abs(b).toFixed(1)}
          </span>
        ))}
      </div>
    </div>
  );
}
