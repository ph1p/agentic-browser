import type { Runtime } from "../runtime.js";

export async function runMemoryStats(runtime: Runtime) {
  return runtime.api.memoryStats();
}
