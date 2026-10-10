// Copies the stock agent (../agent, owned at the repository root) into the web app, so that
// POST /api/stocks runs the very same files as the local server. Vercel only receives /web, so the
// copies are committed; `pnpm build` runs this first, and it does nothing where ../agent is absent.
//   pnpm sync:agent
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

// The folder layout is kept (agent/ next to js/), so the files' relative imports still resolve.
export const SYNCED_FILES = [
  "agent/gemini.js",
  "agent/tools.js",
  "agent/retrieval.js",
  "agent/signals.js",
  "agent/memory.js",
  "agent/basket.js",
  "agent/project-notes.json",
  "js/controller.js",
];

const root = path.join(process.cwd(), "..");
const target = path.join(process.cwd(), "src", "lib", "agent-core");

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

if (!(await exists(path.join(root, "agent", "gemini.js")))) {
  console.log("sync:agent: ../agent not found (a Vercel build); using the committed copies.");
} else {
  let changed = 0;
  for (const file of SYNCED_FILES) {
    const from = path.join(root, file);
    const to = path.join(target, file);
    const [next, current] = await Promise.all([readFile(from), readFile(to).catch(() => null)]);
    if (current && next.equals(current)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    changed += 1;
  }
  console.log(`sync:agent: ${SYNCED_FILES.length} files checked, ${changed} updated.`);
}
