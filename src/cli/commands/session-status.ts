import type { Runtime } from "../runtime.js";

export async function runSessionStatus(runtime: Runtime, input: { sessionId: string }) {
  return runtime.api.getSession(input.sessionId);
}
