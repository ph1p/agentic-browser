import type { Runtime } from "../runtime.js";

export async function runSessionRestart(runtime: Runtime, input: { sessionId: string }) {
  return await runtime.api.restartSession(input.sessionId);
}
