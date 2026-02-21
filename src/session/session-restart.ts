import type { SessionManager } from "./session-manager.js";

export class SessionRestartService {
  constructor(private readonly sessions: SessionManager) {}

  restart(sessionId: string) {
    return this.sessions.restartSession(sessionId);
  }
}
