import type { Runtime } from "../runtime.js";

export async function runSessionStop(runtime: Runtime, input: { sessionId: string }) {
  await runtime.api.terminateSession(input.sessionId);
  return { terminated: true };
}
