import type { SessionManager } from "./session-manager.js";

export class DisconnectHandler {
  constructor(private readonly sessions: SessionManager) {}

  handleDisconnect(sessionId: string, reason: string): void {
    const current = this.sessions.getSession(sessionId);
    if (current.status === "ready") {
      this.sessions.setStatus("disconnected", reason);
    }
  }
}
