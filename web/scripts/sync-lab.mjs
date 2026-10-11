// Copies Shaun's paper-trading Lab (../experiment, his folder is the source) into the web app, so
// that Vercel, which only receives /web, can host it at /lab. Never edit the copies.
//   pnpm sync:lab
// Two targets:
//   src/lib/agent-core/experiment/  the modules the /api/lab routes run. They sit next to the agent
//                                   copies, so their "../agent/..." imports resolve unchanged.
//   public/lab-static/              the Lab's frontend, served at /lab and /lab/basket.
// The copies are byte-identical except for the few replacements below. Each one names the exact
// text it expects and how often; when the Lab changes that text, the sync stops instead of guessing.
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  DEVICE_DARK,
  LAB_DARK_LINK_ID,
  THEME_TOGGLE_HTML,
  themeHeadScript,
  themeToggleScript,
} from "../src/lib/theme/theme.mjs";

export const DISCLAIMER =
  "Paper portfolios for research and fun. Not investment advice. Not affiliated with Polymarket or Kalshi.";

// Outside #app, because the Lab re-renders everything inside it.
// The site's shared header (the same links as src/app/productView.ts NAV; a spec compares them).
export const LAB_NAV_LINKS = [
  ["/", "Build"],
  ["/lab", "Paper-trade Lab"],
  ["/track-record", "Track record"],
  ["/how-it-works", "How it works"],
];
const LAB_NAV =
  '<header class="lab-nav"><a class="lab-logo" href="/"><span aria-hidden="true">p.</span>ProphETF</a>' +
  '<nav aria-label="Main">' +
  LAB_NAV_LINKS.map(
    ([href, label]) =>
      `<a href="${href}"${href === "/lab" ? ' aria-current="page"' : ""}>${label}</a>`,
  ).join("") +
  "</nav>" +
  // The site's one light/dark button, with its behaviour for this static page.
  THEME_TOGGLE_HTML +
  `<script>${themeToggleScript(LAB_DARK_LINK_ID)}</script>` +
  "</header>" +
  '<div id="lab-handoff" class="lab-handoff" role="status" hidden></div>';
const LAB_FOOTER = `<footer class="lab-footer"><p id="lab-data-as-of" hidden></p><p>${DISCLAIMER}</p></footer>`;

/** @type {{ from: string, to: string, edits?: [string, string, number][] }[]} */
export const LAB_FILES = [
  {
    from: "data.js",
    to: "src/lib/agent-core/experiment/data.js",
    edits: [
      // The hosted Lab only reads its bundled snapshot. Without these three, the bundler would
      // look for the Lab's local cache file and trace the whole project into the function.
      [
        'import { readFile, writeFile, mkdir } from "node:fs/promises";',
        'const readFile = async () => { throw new Error("The hosted Lab has no local files."); }, writeFile = readFile, mkdir = readFile;',
        1,
      ],
      [
        'const CACHE = new URL("./.cache/snapshot.json", import.meta.url);',
        "const CACHE = null;",
        1,
      ],
      [
        'const SNAPSHOT = new URL("./data/snapshot.json", import.meta.url);',
        "const SNAPSHOT = null;",
        1,
      ],
      // Vercel has no /backend folder: the universe is bundled from the app's own copy.
      [
        'const UNIVERSE = JSON.parse(await readFile(new URL("../backend/src/polyslice_api/data/universe.json", import.meta.url), "utf8"));',
        'import UNIVERSE from "../../stocks/universe.data.json" with { type: "json" };',
        1,
      ],
    ],
  },
  { from: "math.js", to: "src/lib/agent-core/experiment/math.js" },
  { from: "suggestions.js", to: "src/lib/agent-core/experiment/suggestions.js" },
  { from: "preferences.js", to: "src/lib/agent-core/experiment/preferences.js" },
  { from: "evidence.js", to: "src/lib/agent-core/experiment/evidence.js" },
  { from: "kalshi.js", to: "src/lib/agent-core/experiment/kalshi.js" },
  { from: "data/snapshot.json", to: "src/lib/agent-core/experiment/data/snapshot.json" },
  {
    from: "app.js",
    to: "public/lab-static/app.js",
    edits: [
      // The Lab lives under /lab and its API under /api/lab.
      ['"/api/', '"/api/lab/', 4],
      ['"/basket', '"/lab/basket', 8],
      ['"/events"', '"/lab/events"', 1],
      ['"/"', '"/lab"', 7],
      // The hand-off from the AI page runs first (public/lab-own/bridge.js is ours, not part of the Lab).
      [
        'import { scenarioPath } from "./math.js";',
        'import "../lab-own/bridge.js";\nimport { scenarioPath } from "./math.js";',
        1,
      ],
    ],
  },
  { from: "charts.js", to: "public/lab-static/charts.js" },
  { from: "session.js", to: "public/lab-static/session.js" },
  { from: "math.js", to: "public/lab-static/math.js" },
  { from: "styles.css", to: "public/lab-static/styles.css" },
  {
    from: "index.html",
    to: "public/lab-static/index.html",
    edits: [
      [
        'href="/styles.css">',
        'href="/lab-static/styles.css"><link rel="stylesheet" href="/lab-own/lab-extra.css">' +
          // The dark palette, on while the device is dark; the script right after it applies a
          // saved choice before the first paint.
          `<link id="${LAB_DARK_LINK_ID}" rel="stylesheet" href="/lab-own/lab-dark.css" media="${DEVICE_DARK}">` +
          `<script>${themeHeadScript(LAB_DARK_LINK_ID)}</script>`,
        1,
      ],
      ['src="/app.js"', 'src="/lab-static/app.js"', 1],
      ['<body><div id="app">', `<body>${LAB_NAV}<div id="app">`, 1],
      ["</div></body>", `</div>${LAB_FOOTER}</body>`, 1],
    ],
  },
];

/**
 * The copy of one Lab file. Throws when a replacement does not find its text exactly as often as
 * expected.
 * @param {{ from: string, edits?: [string, string, number][] }} file
 * @param {Buffer} source
 * @returns {Buffer}
 */
export function labCopy(file, source) {
  if (!file.edits?.length) return source;
  let text = source.toString("utf8");
  for (const [find, replacement, times] of file.edits) {
    const found = text.split(find).length - 1;
    if (found !== times) {
      throw new Error(
        `sync:lab: experiment/${file.from}: expected ${JSON.stringify(find)} ${times} time(s), found ${found}. ` +
          "The Lab changed; update scripts/sync-lab.mjs.",
      );
    }
    text = text.split(find).join(replacement);
  }
  return Buffer.from(text, "utf8");
}

const exists = (file) =>
  stat(file).then(
    () => true,
    () => false,
  );

/** Writes the copies under `webDir` from `labDir`. Returns how many files changed. */
export async function syncLab({ labDir, webDir }) {
  let changed = 0;
  for (const file of LAB_FILES) {
    const next = labCopy(file, await readFile(path.join(labDir, file.from)));
    const to = path.join(webDir, file.to);
    const current = await readFile(to).catch(() => null);
    if (current && next.equals(current)) continue;
    await mkdir(path.dirname(to), { recursive: true });
    await writeFile(to, next);
    changed += 1;
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const labDir = path.join(process.cwd(), "..", "experiment");
  if (!(await exists(path.join(labDir, "app.js")))) {
    console.log("sync:lab: ../experiment not found (a Vercel build); using the committed copies.");
  } else {
    const changed = await syncLab({ labDir, webDir: process.cwd() });
    console.log(`sync:lab: ${LAB_FILES.length} files checked, ${changed} updated.`);
  }
}
