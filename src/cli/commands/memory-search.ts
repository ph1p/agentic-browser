import type { Runtime } from "../runtime.js";

export async function runMemorySearch(
  runtime: Runtime,
  input: { taskIntent: string; siteDomain?: string; limit?: number },
) {
  if (!input.taskIntent || !input.taskIntent.trim()) {
    throw new Error("taskIntent is required");
  }
  return runtime.api.searchMemory(input);
}
