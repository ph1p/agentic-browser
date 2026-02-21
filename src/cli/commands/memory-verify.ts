import type { Runtime } from "../runtime.js";

export async function runMemoryVerify(runtime: Runtime, input: { insightId: string }) {
  if (!input.insightId || !input.insightId.trim()) {
    throw new Error("insightId is required");
  }
  return runtime.api.verifyMemory(input.insightId);
}
