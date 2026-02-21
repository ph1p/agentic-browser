import type { SessionTokenService } from "../auth/session-token.js";

export function verifyBearerAuth(
  tokenService: SessionTokenService,
  sessionId: string,
  token: string,
): boolean {
  return tokenService.validate(sessionId, token);
}
