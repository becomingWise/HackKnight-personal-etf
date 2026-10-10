// Eval of the DECIDER prompt against real Gemini with fixed mock packets (no Polymarket, no DB):
//   pnpm eval:decider                 all 10 cases, paced for the free quota (about 2 to 4 minutes)
//   pnpm eval:decider --only fed      cases whose name contains "fed"
//   pnpm eval:decider --pace 0        no pause between calls (paid quota only)
// Run it before and after every prompt change in src/lib/pipeline/decider.ts and compare the totals.
//
// Per case it reports:
//   first    the first answer passed every checker rule (no revision needed)
//   final    the returned answer came from Gemini and passes every checker rule
//   grounded every number in the reasons and the summary is backed by the cited markets
import { check, ungroundedNumbers } from "../src/lib/pipeline/checker";
import { EVAL_CASES } from "../src/lib/pipeline/evalCases";
import { gate } from "../src/lib/pipeline/gate";
import { decideFromPacket } from "../src/lib/pipeline/run";
import { GEMINI_MODEL, geminiGenerateJson } from "../src/lib/sponsors/gemini";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
// 13 seconds per Gemini call keeps the run under the free 5 requests per minute.
const paceSeconds = Number(option("pace") ?? 13);
const only = option("only");
const cases = EVAL_CASES.filter((c) => !only || c.name.includes(only));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const mark = (ok: boolean | null) => (ok === null ? "-" : ok ? "yes" : "NO");
const rows: {
  name: string;
  expected: boolean;
  first: boolean | null;
  final: boolean | null;
  grounded: boolean | null;
  calls: number;
  ms: number;
}[] = [];

console.log(
  `decider eval: ${cases.length} cases, model ${GEMINI_MODEL}, pace ${paceSeconds} s per call\n`,
);

for (const c of cases) {
  const now = new Date();
  const packet = c.packet(now);
  const started = Date.now();
  const result = await decideFromPacket(c.idea, packet, {
    generate: geminiGenerateJson,
    checkerLlm: false,
  });
  const ms = Date.now() - started;
  const notes: string[] = [];

  if (!result.ok) {
    rows.push({
      name: c.name,
      expected: c.expect === "not_enough_evidence",
      first: null,
      final: null,
      grounded: null,
      calls: 0,
      ms,
    });
  } else {
    const usable = gate(packet, now).packet;
    const firstErrors =
      result.firstAnswer === null
        ? ["no answer from Gemini"]
        : check(result.firstAnswer, usable).errors;
    const modelSummary = result.response.summary.split(" Key Polymarket odds:")[0];
    const finalErrors =
      result.response.source === "gemini"
        ? check({ summary: modelSummary, stocks: result.decided }, usable).errors
        : ["evidence-only fallback"];
    const evidence = usable.markets.map((m) => m.question).join(" ");
    const loose = [
      ...result.decided.flatMap((s) =>
        ungroundedNumbers(s, usable).map((n) => `${s.symbol}: ${n}`),
      ),
      ...(modelSummary.match(/\d+(?:[.,]\d+)?/g) ?? [])
        .filter((n) => !evidence.includes(n))
        .map((n) => `summary: ${n}`),
    ];
    if (firstErrors.length) notes.push(...firstErrors.map((e) => `first answer: ${e}`));
    if (finalErrors.length) notes.push(...finalErrors.map((e) => `final answer: ${e}`));
    if (loose.length) notes.push(`ungrounded numbers: ${loose.join(", ")}`);
    rows.push({
      name: c.name,
      expected: c.expect === "decision",
      first: firstErrors.length === 0,
      final: finalErrors.length === 0,
      grounded: finalErrors.length === 0 && loose.length === 0,
      calls: result.geminiCalls,
      ms,
    });
  }

  const row = rows.at(-1)!;
  console.log(
    `${row.name.padEnd(20)} outcome ${mark(row.expected).padEnd(4)} first ${mark(row.first).padEnd(4)} final ${mark(row.final).padEnd(4)} grounded ${mark(row.grounded).padEnd(4)} ${row.calls} calls ${String(row.ms).padStart(6)} ms`,
  );
  if (result.ok)
    console.log(
      `  ${result.decided.map((s) => s.symbol).join(", ")} | ${(result.response.trace ?? []).map((t) => `${t.step}: ${t.summary}`).join(" | ")}`,
    );
  for (const note of notes) console.log(`  ! ${note}`);
  if (row.calls && c !== cases.at(-1)) await sleep(paceSeconds * 1000 * row.calls);
}

const decided = rows.filter((r) => r.first !== null);
const rate = (n: number, of: number) =>
  `${n}/${of}${of ? ` (${Math.round((100 * n) / of)}%)` : ""}`;
const latencies = decided.map((r) => r.ms).sort((a, b) => a - b);
console.log(
  [
    "",
    `expected outcome   ${rate(rows.filter((r) => r.expected).length, rows.length)}`,
    `first-answer pass  ${rate(decided.filter((r) => r.first).length, decided.length)}`,
    `final pass         ${rate(decided.filter((r) => r.final).length, decided.length)}`,
    `grounded           ${rate(decided.filter((r) => r.grounded).length, decided.length)}`,
    `Gemini calls       ${decided.reduce((sum, r) => sum + r.calls, 0)} for ${decided.length} decisions`,
    `latency            median ${latencies[Math.floor(latencies.length / 2)] ?? 0} ms, max ${latencies.at(-1) ?? 0} ms`,
  ].join("\n"),
);
