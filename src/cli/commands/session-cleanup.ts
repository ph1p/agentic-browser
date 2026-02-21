import type { Runtime } from "../runtime.js";

export async function runSessionCleanup(
  runtime: Runtime,
  input: { maxAgeDays?: number; dryRun?: boolean },
) {
  return runtime.api.cleanupSessions(input);
}
