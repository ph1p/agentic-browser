import type { Runtime } from "../runtime.js";

export async function runSessionAuth(runtime: Runtime, input: { sessionId: string }) {
  const token = runtime.api.rotateSessionToken(input.sessionId);
  return {
    token,
    valid: runtime.context.tokenService.validate(input.sessionId, token),
  };
}
