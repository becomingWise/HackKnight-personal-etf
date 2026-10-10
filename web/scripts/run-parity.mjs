// Runs scripts/gen-weights-parity.py with the Python in PARITY_PYTHON (default: "python").
// That Python needs fastapi and httpx; see the header of the .py file.
import { spawnSync } from "node:child_process";

const python = process.env.PARITY_PYTHON || "python";
const result = spawnSync(python, ["scripts/gen-weights-parity.py"], { stdio: "inherit" });
if (result.error) {
  console.error(`Could not run "${python}": ${result.error.message}. Set PARITY_PYTHON.`);
  process.exit(1);
}
process.exit(result.status ?? 1);
