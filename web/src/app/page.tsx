import { Suspense } from "react";
import { connection } from "next/server";
import { getHealth } from "@/lib/health";

const SPONSOR_LABELS = {
  tiger: "Tiger Data",
  gemini: "Gemini",
  snowflake: "Snowflake Cortex",
  elevenlabs: "ElevenLabs",
  solana: "Solana devnet",
  presage: "Presage",
  ws: "Live WebSocket",
} as const;

async function SystemStatus() {
  await connection();
  const health = await getHealth();
  const db = health.database;
  return (
    <div className="grid gap-5">
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <span
          aria-hidden="true"
          className={`size-2.5 rounded-full ${db.ok ? "bg-up" : "bg-down"}`}
        />
        {db.ok ? (
          <>
            <strong>Database connected.</strong>
            <span className="text-muted">
              Postgres {db.postgres} · TimescaleDB {db.timescaledb ?? "not installed"} ·{" "}
              {db.migrations} migrations · {db.latency_ms} ms
            </span>
          </>
        ) : (
          <>
            <strong>Database unreachable.</strong>
            <span className="text-muted">{db.error}</span>
          </>
        )}
      </p>
      <ul className="flex flex-wrap gap-2">
        {Object.entries(health.sponsors).map(([key, s]) => (
          <li
            key={key}
            className={`rounded-full px-3 py-1 text-xs font-medium ${
              s.mode === "live" ? "bg-up-soft text-up" : "bg-warn-soft text-warn"
            }`}
          >
            {SPONSOR_LABELS[key as keyof typeof SPONSOR_LABELS]} · {s.mode}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function Home() {
  return (
    <div className="grid gap-8">
      <section className="grid gap-4">
        <p className="text-xs font-semibold tracking-[0.18em] text-blue">
          PERSONAL ETFS FROM PREDICTION MARKETS
        </p>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          Turn what you believe about the future into a fund.
        </h1>
        <p className="max-w-2xl text-lg text-muted">
          Pick YES or NO on real Polymarket questions, give each a weight, and ProphETF values your
          basket live from market prices. Paper money only.
        </p>
      </section>

      <section className="rounded-panel border border-line bg-surface p-6">
        <p className="text-xs font-semibold tracking-[0.18em] text-muted">SYSTEM STATUS</p>
        <h2 className="mt-1 mb-4 text-xl font-semibold">The scaffold is up.</h2>
        <Suspense fallback={<p className="text-sm text-muted">Checking the database…</p>}>
          <SystemStatus />
        </Suspense>
        <p className="mt-5 text-sm text-muted">
          Raw JSON at{" "}
          <a className="text-blue underline" href="/api/health">
            /api/health
          </a>
          . Markets, the builder and factsheets arrive in the next phases.
        </p>
      </section>
    </div>
  );
}
