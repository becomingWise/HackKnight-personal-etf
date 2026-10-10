import { Suspense } from "react";
import { connection } from "next/server";
import { DEMO_IDEAS } from "@/lib/demo/warm";
import { getHealth } from "@/lib/health";
import { Console } from "./console";

const SPONSOR_LABELS = {
  tiger: "Tiger Data",
  gemini: "Gemini",
  elevenlabs: "ElevenLabs",
  ws: "Live WebSocket",
} as const;

async function SystemStatus() {
  await connection();
  const health = await getHealth();
  const db = health.database;
  const lite = health.gemini.models.filter((m) => m.model.includes("flash-lite"));
  const left = lite.reduce((sum, m) => sum + (m.blockedUntil ? 0 : m.remainingToday), 0);
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs">
      <span className="flex items-center gap-2">
        <span aria-hidden="true" className={`size-2 rounded-full ${db.ok ? "bg-up" : "bg-down"}`} />
        {db.ok ? (
          <span>
            Database connected
            <span className="text-muted">
              {" "}
              · Postgres {db.postgres} · TimescaleDB {db.timescaledb ?? "not installed"} ·{" "}
              {db.latency_ms} ms
            </span>
          </span>
        ) : (
          <span>
            Database unreachable <span className="text-muted">· {db.error}</span>
          </span>
        )}
      </span>
      <ul className="flex flex-wrap gap-1.5">
        {Object.entries(health.sponsors)
          // The live-feed flag was never built; only what the product uses is shown.
          .filter(([key]) => key !== "ws")
          .map(([key, s]) => (
            <li
              key={key}
              className={`rounded-full px-2.5 py-0.5 font-medium ${
                s.mode === "live" ? "bg-up-soft text-up" : "bg-warn-soft text-warn"
              }`}
            >
              {SPONSOR_LABELS[key as keyof typeof SPONSOR_LABELS]} · {s.mode}
            </li>
          ))}
      </ul>
      <span className="text-muted">Gemini Flash-Lite calls left today: {left}</span>
    </div>
  );
}

export default function Home() {
  return (
    <div className="grid gap-5">
      <section className="grid gap-2">
        <p className="text-xs font-semibold tracking-[0.18em] text-blue">
          BACKEND TEST CONSOLE — THE PRODUCT UI IS BUILT BY OUR FRONTEND TEAMMATE
        </p>
        <h1 className="max-w-3xl text-3xl font-bold tracking-tight">
          An idea in, three stocks and their weights out.
        </h1>
        <p className="max-w-3xl text-muted">
          This page calls the live API in order: <code>/api/stocks</code> (a Gemini agent picks
          three stocks for the idea), then <code>/api/weights</code> (the weights are tilted by how
          Polymarket odds moved).
        </p>
      </section>

      <section className="rounded-panel border border-line bg-surface px-5 py-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <p className="text-xs font-semibold tracking-[0.18em] text-muted">SYSTEM STATUS</p>
          <Suspense fallback={<p className="text-xs text-muted">Checking the database…</p>}>
            <SystemStatus />
          </Suspense>
          <span className="ml-auto text-xs text-muted">
            <a className="text-blue underline" href="/api/health">
              /api/health
            </a>{" "}
            ·{" "}
            <a className="text-blue underline" href="/api/built-with">
              /api/built-with
            </a>
          </span>
        </div>
      </section>

      <Console demoIdeas={DEMO_IDEAS} />
    </div>
  );
}
