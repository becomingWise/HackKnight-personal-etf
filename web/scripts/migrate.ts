// Plain SQL migration runner: applies db/migrations/*.sql in filename order, once each.
//   pnpm db:migrate      apply pending migrations
//   pnpm db:status       list applied / pending
//
// A file runs inside one transaction by default. Statements TimescaleDB refuses to run in a
// transaction (continuous aggregates, some policies) go in a file whose first line is
//   -- migrate:no-transaction
// with statements separated by lines containing only
//   -- migrate:split
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

const NO_TX = /^\s*--\s*migrate:no-transaction\s*$/m;
const SPLIT = /^\s*--\s*migrate:split\s*$/m;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set (expected in .env.local).");
    process.exit(1);
  }
  const statusOnly = process.argv.includes("--status");
  const dir = path.join(process.cwd(), "db", "migrations");
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  const sql = postgres(url, { max: 1, onnotice: () => {} });

  try {
    await sql`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamptz not null default now()
      )`;
    const applied = new Set(
      (await sql<{ name: string }[]>`select name from schema_migrations`).map((r) => r.name),
    );

    if (statusOnly) {
      for (const f of files) console.log(`${applied.has(f) ? "applied" : "PENDING"}  ${f}`);
      return;
    }

    const pending = files.filter((f) => !applied.has(f));
    if (pending.length === 0) {
      console.log(`Up to date (${files.length} migrations).`);
      return;
    }

    for (const file of pending) {
      const text = await readFile(path.join(dir, file), "utf8");
      const started = Date.now();
      if (NO_TX.test(text)) {
        const parts = text
          .split(SPLIT)
          .map((s) => s.trim())
          .filter((s) => s.replace(/^\s*--.*$/gm, "").trim() !== "");
        for (const part of parts) await sql.unsafe(part);
        await sql`insert into schema_migrations (name) values (${file})`;
      } else {
        await sql.begin(async (tx) => {
          await tx.unsafe(text);
          await tx`insert into schema_migrations (name) values (${file})`;
        });
      }
      console.log(`applied  ${file}  (${Date.now() - started} ms)`);
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(`Migration failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
