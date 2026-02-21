import type { SessionTokenService } from "../auth/session-token.js";

export function verifyWsClient(
  tokenService: SessionTokenService,
  sessionId: string | null,
  token: string | null,
): boolean {
  if (!sessionId || !token) {
    return false;
  }
  return tokenService.validate(sessionId, token);
}
