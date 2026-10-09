"use client";

import { useState } from "react";
import { api, type BasketParams, type Ticket } from "@/lib/api";
import { pct, usd } from "@/lib/format";

export default function TradeTicket({ params }: { params: BasketParams }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState("1000");
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const value = Number(amount.replace(/[$,]/g, ""));
  const valid = Number.isFinite(value) && value > 0;

  async function generate() {
    setBusy(true);
    setError(null);
    try {
      setTicket(await api.ticket({ ...params, amount: value }));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        onClick={() => {
          setOpen(true);
          setTicket(null);
        }}
        className="rounded-lg bg-gradient-to-r from-brand to-brand-2 px-3 py-1.5 text-xs font-semibold text-ink shadow-lg shadow-brand/20 hover:brightness-110"
      >
        Simulate buy
      </button>

      {open && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-ink/70 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <div
            role="dialog"
            aria-modal
            aria-label="Simulated trade ticket"
            className="w-full max-w-lg rounded-2xl border border-line-2 bg-panel p-5 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="font-semibold">Simulated trade ticket</h3>
              <button onClick={() => setOpen(false)} className="text-muted hover:text-text" aria-label="Close">
                ✕
              </button>
            </div>
            <p className="mt-1 text-xs text-muted">Paper allocation at today’s live weights. No orders are placed.</p>

            <form
              className="mt-4 flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (valid) generate();
              }}
            >
              <div className="flex flex-1 items-center rounded-lg border border-line-2 bg-panel-2 px-3">
                <span className="text-muted">$</span>
                <input
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  inputMode="decimal"
                  className="num w-full bg-transparent px-2 py-2 outline-none"
                  aria-label="Amount to invest"
                />
              </div>
              <button
                disabled={!valid || busy}
                className="rounded-lg bg-text px-4 text-sm font-medium text-ink disabled:opacity-40"
              >
                {busy ? "Pricing…" : "Allocate"}
              </button>
            </form>
            {error && <p className="mt-2 text-xs text-down">{error}</p>}

            {ticket && (
              <div className="mt-4 max-h-[50vh] overflow-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-dim">
                      <th className="pb-2 font-normal">Ticker</th>
                      <th className="pb-2 text-right font-normal">Weight</th>
                      <th className="pb-2 text-right font-normal">Price</th>
                      <th className="pb-2 text-right font-normal">Shares</th>
                      <th className="pb-2 text-right font-normal">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="num">
                    {ticket.lines.map((l) => (
                      <tr key={l.symbol} className="border-t border-line">
                        <td className="py-2 font-medium">{l.symbol}</td>
                        <td className="text-right text-muted">{pct(l.weight_pct)}</td>
                        <td className="text-right text-muted">{l.price ? usd(l.price) : "—"}</td>
                        <td className="text-right">{l.units !== null ? l.units.toFixed(4) : "—"}</td>
                        <td className="text-right">{usd(l.dollars)}</td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="border-t border-line-2 font-semibold">
                      <td className="pt-2" colSpan={4}>
                        Total
                      </td>
                      <td className="num pt-2 text-right">
                        {usd(ticket.lines.reduce((s, l) => s + l.dollars, 0))}
                      </td>
                    </tr>
                  </tfoot>
                </table>
                <p className="mt-3 text-[11px] text-dim">
                  Fractional shares at last close. Simulation only — not investment advice.
                </p>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
