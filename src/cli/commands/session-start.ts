import type { Runtime } from "../runtime.js";
import { formatResult } from "../output/result-formatter.js";

export async function runSessionStart(runtime: Runtime, input: { browser: "chrome" }) {
  const session = await runtime.api.createSession(input);
  return {
    ...formatResult("success", "Session started"),
    sessionId: session.sessionId,
  };
}
