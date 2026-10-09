"use client";

import { Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import type { Holding } from "@/lib/api";
import { pct, sectorColor, signedPct, tone } from "@/lib/format";

export function shadeIndex(holdings: Holding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  return Object.fromEntries(holdings.map((h) => [h.symbol, (counts[h.sector] = (counts[h.sector] ?? -1) + 1)]));
}

export default function AllocationChart({ holdings }: { holdings: Holding[] }) {
  const shade = shadeIndex(holdings);
  const live = holdings.map((h) => ({ ...h, fill: sectorColor(h.sector, shade[h.symbol]) }));
  const base = holdings.map((h) => ({ ...h, fill: sectorColor(h.sector, shade[h.symbol], 0.35) }));
  const movers = holdings.slice().sort((a, b) => Math.abs(b.change_pct) - Math.abs(a.change_pct)).slice(0, 3);
  const turnover = holdings.reduce((sum, h) => sum + Math.abs(h.change_pct), 0) / 2;

  return (
    <div className="grid items-center gap-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="relative aspect-square w-full max-w-[320px] justify-self-center">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={base} dataKey="base_pct" nameKey="symbol" innerRadius="48%" outerRadius="58%" stroke="none" isAnimationActive={false} />
            <Pie
              data={live}
              dataKey="weight_pct"
              nameKey="symbol"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={1.2}
              stroke="none"
              animationDuration={450}
            />
            <Tooltip content={<SliceTip />} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <span className="num text-2xl font-semibold">{pct(turnover)}</span>
          <span className="text-[11px] text-muted">rebalanced vs base</span>
        </div>
      </div>

      <div className="space-y-4">
        <div className="text-xs text-muted">
          <span className="mr-3 inline-flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-sm bg-text/80" /> outer: live weights
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="h-2 w-4 rounded-sm bg-text/25" /> inner: base
          </span>
        </div>
        <div>
          <p className="mb-2 text-xs uppercase tracking-wider text-dim">Biggest moves</p>
          <ul className="space-y-2">
            {movers.map((h) => (
              <li key={h.symbol} className="flex items-center justify-between gap-3 rounded-lg bg-panel-2 px-3 py-2">
                <span className="flex items-center gap-2">
                  <span className="h-2.5 w-2.5 rounded-full" style={{ background: sectorColor(h.sector, shade[h.symbol]) }} />
                  <span className="num font-medium">{h.symbol}</span>
                </span>
                <span className="num text-sm">
                  <span className="text-muted">{pct(h.base_pct)}</span>
                  <span className="mx-1.5 text-dim">→</span>
                  {pct(h.weight_pct)}
                  <span className={`ml-2 ${tone(h.change_pct)}`}>{signedPct(h.change_pct)}</span>
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}

function SliceTip({ active, payload }: { active?: boolean; payload?: { payload: Holding }[] }) {
  if (!active || !payload?.length) return null;
  const h = payload[0].payload;
  return (
    <div className="rounded-lg border border-line-2 bg-panel-2 px-3 py-2 text-xs shadow-xl">
      <p className="num font-semibold">{h.symbol}</p>
      <p className="text-muted">{h.name}</p>
      <p className="num mt-1">
        {pct(h.base_pct)} → {pct(h.weight_pct)} <span className={tone(h.change_pct)}>{signedPct(h.change_pct)}</span>
      </p>
    </div>
  );
}
