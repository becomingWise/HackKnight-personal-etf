// Option A of docs/HANDOFF.md: the real analyst is a TypeScript module with this one export.
// ANALYST_MODE=module makes the pipeline call it. Until it is written it throws, and the
// pipeline answers with the signals analyst and says so in the trace.
import type { EvidencePacket } from "./packet";

export async function analyze(idea: string, signal?: AbortSignal): Promise<EvidencePacket> {
  void idea;
  void signal;
  throw new Error("the analyst module is not implemented yet");
}
