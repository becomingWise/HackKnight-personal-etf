"use client";

import type { Holding } from "@/lib/api";
import { pct, pts, sectorColor, signedPct, tone } from "@/lib/format";
import { shadeIndex } from "./AllocationChart";

export default function HoldingsTable({ holdings, labels }: { holdings: Holding[]; labels: Record<string, string> }) {
  const shade = shadeIndex(holdings);
  const maxChange = Math.max(1, ...holdings.map((h) => Math.abs(h.change_pct)));
  const rows = holdings.slice().sort((a, b) => b.weight_pct - a.weight_pct);

  return (
    <div className="-mx-2 overflow-x-auto">
      <table className="w-full min-w-[560px] text-sm">
        <thead>
          <tr className="text-left text-xs text-dim">
            <th className="px-2 pb-2 font-normal">Holding</th>
            <th className="px-2 pb-2 text-right font-normal">Base</th>
            <th className="px-2 pb-2 text-right font-normal">Live</th>
            <th className="w-32 px-2 pb-2 font-normal">Change</th>
            <th className="px-2 pb-2 font-normal">Top driver</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((h) => {
            const top = h.contributions[0];
            const w = (Math.abs(h.change_pct) / maxChange) * 50;
            return (
              <tr key={h.symbol} className="border-t border-line">
                <td className="px-2 py-2.5">
                  <div className="flex items-center gap-2.5">
                    <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: sectorColor(h.sector, shade[h.symbol]) }} />
                    <span className="num font-medium">{h.symbol}</span>
                    <span className="truncate text-xs text-muted">{h.name}</span>
                  </div>
                </td>
                <td className="num px-2 text-right text-muted">{pct(h.base_pct)}</td>
                <td className="num px-2 text-right">{pct(h.weight_pct)}</td>
                <td className="px-2">
                  <div className="flex items-center gap-2">
                    <div className="relative h-1.5 w-16 rounded-full bg-line">
                      <div className="absolute top-0 h-full w-px bg-line-2" style={{ left: "50%" }} />
                      <div
                        className={`absolute top-0 h-full rounded-full ${h.change_pct >= 0 ? "bg-up" : "bg-down"}`}
                        style={h.change_pct >= 0 ? { left: "50%", width: `${w}%` } : { right: "50%", width: `${w}%` }}
                      />
                    </div>
                    <span className={`num text-xs ${tone(h.change_pct)}`}>{signedPct(h.change_pct)}</span>
                  </div>
                </td>
                <td className="px-2 text-xs">
                  {top && Math.abs(top.effect) > 0.001 ? (
                    <span className="text-muted">
                      {labels[top.signal] ?? top.signal}{" "}
                      <span className={`num ${tone(top.effect, 0)}`}>
                        ({pts(top.delta, 0)} × β{top.beta > 0 ? "+" : ""}
                        {top.beta})
                      </span>
                    </span>
                  ) : (
                    <span className="text-dim">no live signal</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
