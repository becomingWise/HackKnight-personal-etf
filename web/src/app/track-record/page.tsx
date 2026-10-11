import type { Metadata } from "next";
import { TrackRecordLoader } from "./loader";

export const metadata: Metadata = {
  title: "Track record",
  description: "How often the five AI agents were right about a basket beating the S&P 500.",
};

export default function TrackRecordPage() {
  return (
    <div className="grid gap-6">
      <section className="grid gap-3">
        <h1 className="text-3xl font-bold tracking-tight sm:text-4xl">Track record</h1>
        <p className="max-w-3xl text-muted">
          Every basket gets one question: will it, at equal weights, beat the S&amp;P 500 over the
          next week? Five AI agents each answer yes or no with a probability, and a week later the
          answer is scored against what the basket and the S&amp;P 500 (SPY) really did. To have a
          record from day one we replayed eight past Fridays without hindsight: each agent saw only
          the prices and Polymarket odds known on that Friday, and of its own record only the weeks
          that had already ended. Baskets made in the same week rise and fall together, so the 90%
          ranges come from resampling whole weeks, not single decisions. New baskets from the Build
          page are added and scored the same way.
        </p>
      </section>
      <TrackRecordLoader />
    </div>
  );
}
