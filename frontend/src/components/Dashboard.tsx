"use client";

import { useEffect, useMemo, useState } from "react";
import { api, type Basket, type Sector, type Signal, type Window } from "@/lib/api";
import { WINDOW_LABEL } from "@/lib/format";
import AllocationChart from "./AllocationChart";
import HoldingsTable from "./HoldingsTable";
import ScopePicker from "./ScopePicker";
import SignalCard from "./SignalCard";
import Suggestions from "./Suggestions";
import TradeTicket from "./TradeTicket";

const REFRESH_MS = 60_000;

export default function Dashboard() {
  const [sectors, setSectors] = useState<Sector[]>([]);
  const [scope, setScope] = useState<string[]>(["semis"]);
  const [lookback, setLookback] = useState<Window>("1w");
  const [sensitivity, setSensitivity] = useState(2);
  const [overrides, setOverrides] = useState<Record<string, number>>({});
  const [basket, setBasket] = useState<Basket | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    api.sectors().then(setSectors).catch((e) => setError(String(e)));
  }, []);

  // Refetch on any input change (debounced for sliders) and once a minute for fresh odds.
  useEffect(() => {
    if (scope.length === 0) return;
    const ctrl = new AbortController();
    const t = setTimeout(() => {
      api
        .basket({ scope, window: lookback, sensitivity, overrides }, ctrl.signal)
        .then((b) => {
          setBasket(b);
          setError(null);
        })
        .catch((e) => {
          if (!ctrl.signal.aborted) setError(String(e));
        });
    }, 120);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [scope, lookback, sensitivity, overrides, tick]);

  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), REFRESH_MS);
    return () => clearInterval(id);
  }, []);

  const signalLabels = useMemo(
    () => Object.fromEntries((basket?.signals ?? []).map((s) => [s.id, s.label])),
    [basket],
  );
  const whatIf = Object.keys(overrides).length > 0;
  const params = { scope, window: lookback, sensitivity, overrides };

  return (
    <div className="mx-auto w-full max-w-7xl px-4 pb-16 sm:px-6">
      <header className="flex flex-wrap items-center justify-between gap-4 py-6">
        <div className="flex items-center gap-3">
          <Logo />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">PolySlice</h1>
            <p className="text-xs text-muted">Baskets that rebalance on live prediction-market odds</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-4 text-xs">
          <LiveBadge asOf={basket?.as_of} />
          <Segmented
            label="Look-back"
            value={lookback}
            options={(["1d", "1w", "1m"] as const).map((w) => ({ value: w, label: WINDOW_LABEL[w] }))}
            onChange={setLookback}
          />
          <label className="flex items-center gap-2 text-muted">
            Sensitivity
            <input
              type="range"
              min={0}
              max={6}
              step={0.5}
              value={sensitivity}
              onChange={(e) => setSensitivity(Number(e.target.value))}
              className="w-24"
              aria-label="Sensitivity"
            />
            <span className="num w-8 text-text">{sensitivity.toFixed(1)}×</span>
          </label>
        </div>
      </header>

      <ScopePicker sectors={sectors} scope={scope} onChange={setScope} />

      {error && (
        <div className="mt-4 rounded-lg border border-down/40 bg-down/10 px-4 py-3 text-sm text-down">
          Couldn’t reach the PolySlice API ({error}). Is the backend running on port 8000?
        </div>
      )}

      {scope.length === 0 ? (
        <p className="mt-10 text-center text-muted">Pick at least one sector to build a basket.</p>
      ) : (
        basket && (
          <>
            <Suggestions
              suggestions={basket.suggestions}
              window={lookback}
              onAdd={(id) => setScope((s) => [...s, id])}
            />

            <div className="mt-6 grid gap-6 lg:grid-cols-12">
              <section className="space-y-6 lg:col-span-7">
                <Panel
                  title="Allocation"
                  subtitle={whatIf ? "What-if odds applied" : `Tilted by ${WINDOW_LABEL[lookback]} odds moves`}
                  action={<TradeTicket params={params} />}
                >
                  <AllocationChart holdings={basket.holdings} />
                </Panel>
                <Panel title="Holdings" subtitle="Base weight → live weight, with the biggest driver">
                  <HoldingsTable holdings={basket.holdings} labels={signalLabels} />
                </Panel>
              </section>

              <section className="lg:col-span-5">
                <Panel
                  title="Signals"
                  subtitle="Polymarket markets moving this basket"
                  action={
                    whatIf && (
                      <button
                        onClick={() => setOverrides({})}
                        className="rounded-md border border-line-2 px-2 py-1 text-xs text-muted hover:text-text"
                      >
                        Reset what-ifs
                      </button>
                    )
                  }
                >
                  <div className="space-y-3">
                    {basket.signals
                      .slice()
                      // Order by the live move, not the what-if one, so cards don't jump while dragging.
                      .sort((a, b) => liveMove(b) - liveMove(a))
                      .map((s) => (
                        <SignalCard
                          key={s.id}
                          signal={s}
                          window={lookback}
                          override={overrides[s.id]}
                          onOverride={(p) =>
                            setOverrides((o) => {
                              const next = { ...o };
                              if (p === undefined) delete next[s.id];
                              else next[s.id] = p;
                              return next;
                            })
                          }
                        />
                      ))}
                  </div>
                </Panel>
              </section>
            </div>
          </>
        )
      )}

      <footer className="mt-12 text-center text-xs text-dim">
        Simulated portfolios for a HackKnight 2026 demo. Odds from Polymarket; not investment advice.
      </footer>
    </div>
  );
}

const liveMove = (s: Signal) => (s.move ? Math.abs(s.move.live - s.move.ref) : -1);

export function Panel({
  title,
  subtitle,
  action,
  children,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-line bg-panel/80 p-5 backdrop-blur">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold">{title}</h2>
          {subtitle && <p className="text-xs text-muted">{subtitle}</p>}
        </div>
        {action}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2 text-muted" role="group" aria-label={label}>
      {label}
      <div className="flex rounded-lg border border-line bg-panel p-0.5">
        {options.map((o) => (
          <button
            key={o.value}
            onClick={() => onChange(o.value)}
            className={`num rounded-md px-2.5 py-1 ${o.value === value ? "bg-line-2 text-text" : "hover:text-text"}`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function LiveBadge({ asOf }: { asOf?: string }) {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const ago = asOf && now ? Math.max(0, Math.round((now - Date.parse(asOf)) / 1000)) : null;
  return (
    <span className="flex items-center gap-2 rounded-full border border-line bg-panel px-3 py-1 text-muted">
      <span className="live-dot h-2 w-2 rounded-full bg-up" />
      Polymarket live
      {ago !== null && <span className="num text-dim">· {ago}s ago</span>}
    </span>
  );
}

function Logo() {
  return (
    <svg width="36" height="36" viewBox="0 0 36 36" aria-hidden>
      <defs>
        <linearGradient id="lg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#7c6cff" />
          <stop offset="1" stopColor="#36c2ff" />
        </linearGradient>
      </defs>
      <rect width="36" height="36" rx="10" fill="#121826" stroke="#2a3346" />
      <path d="M18 8 A10 10 0 0 1 28 18 L18 18 Z" fill="url(#lg)" />
      <path d="M18 18 L28 18 A10 10 0 1 1 18 8 Z" fill="none" stroke="#5b6479" strokeWidth="1.5" />
    </svg>
  );
}
