// Loads agent/.env into process.env for the local CLI and server. Values already set in the
// environment win. The file is git-ignored; agent/.env.example is the template.
import { readFileSync } from "node:fs";

export function loadAgentEnv(file = new URL("./.env", import.meta.url)) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!match || line.trimStart().startsWith("#")) continue;
    const value = match[2].replace(/^(["'])(.*)\1$/, "$2");
    if (process.env[match[1]] === undefined) process.env[match[1]] = value;
  }
  return true;
}
