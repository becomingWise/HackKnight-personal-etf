"use client";

// One card per technology with live numbers from GET /api/built-with and GET /api/savings
// (database counts; no Gemini call). A number that cannot be read is shown as "—".
import { useEffect, useState } from "react";
import { get } from "../client";
import { techCards, type BuiltWith, type Savings } from "../productView";

export function LiveTech() {
  const [built, setBuilt] = useState<BuiltWith | null>(null);
  const [savings, setSavings] = useState<Savings | null>(null);
  const [settled, setSettled] = useState(false);
  /** When the numbers arrived: "5 minutes ago" is counted from then. */
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);
  useEffect(() => {
    let shown = true;
    void Promise.allSettled([
      get<BuiltWith>("/api/built-with").then((loaded) => shown && setBuilt(loaded)),
      get<Savings>("/api/savings").then((loaded) => shown && setSavings(loaded)),
    ]).then(() => {
      if (!shown) return;
      setLoadedAt(new Date());
      setSettled(true);
    });
    return () => {
      shown = false;
    };
  }, []);

  const cards = techCards(loadedAt ? built : null, savings, loadedAt ?? new Date(0));
  return (
    <div className="grid gap-3">
      <ul className="grid gap-3 sm:grid-cols-2">
        {cards.map((card) => (
          <li key={card.name} className="rounded-panel border border-line bg-surface p-5">
            <h3 className="text-lg font-semibold">{card.name}</h3>
            <p className="mt-1 text-sm text-muted">{card.role}</p>
            <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-3">
              {card.stats.map((stat) => (
                <div key={stat.label}>
                  <dt className="text-xs text-muted">{stat.label}</dt>
                  <dd className="font-mono text-sm font-semibold break-words">{stat.value}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted" role="status">
        {!settled
          ? "Loading the live numbers…"
          : built || savings
            ? "Live numbers, read from the database when this page opened."
            : "The live numbers could not be loaded right now."}
      </p>
    </div>
  );
}
