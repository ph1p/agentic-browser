import type { EventStore } from "../observability/event-store.js";
import type { InteractiveElementsOptions } from "../session/browser-controller.js";
import type { SessionManager } from "../session/session-manager.js";

export class ControlApi {
  constructor(
    private readonly sessions: SessionManager,
    private readonly eventStore: EventStore,
  ) {}

  async createSession(input: { browser: "chrome" }) {
    return await this.sessions.createSession(input);
  }

  getSession(sessionId: string) {
    return this.sessions.getSession(sessionId);
  }

  async terminateSession(sessionId: string): Promise<void> {
    await this.sessions.terminateSession(sessionId);
  }

  async executeCommand(
    sessionId: string,
    input: {
      commandId: string;
      type: "navigate" | "interact" | "restart" | "terminate";
      payload: Record<string, unknown>;
    },
  ) {
    return await this.sessions.executeCommand(sessionId, input);
  }

  async restartSession(sessionId: string) {
    return await this.sessions.restartSession(sessionId);
  }

  rotateSessionToken(sessionId: string): string {
    return this.sessions.rotateAuthToken(sessionId);
  }

  async getContent(
    sessionId: string,
    options: {
      mode: "title" | "text" | "html" | "a11y" | "summary";
      selector?: string;
      maxChars?: number;
    },
  ) {
    return await this.sessions.getContent(sessionId, options);
  }

  async getInteractiveElements(sessionId: string, options: InteractiveElementsOptions) {
    return await this.sessions.getInteractiveElements(sessionId, options);
  }

  async dismissCookieBanner(sessionId: string) {
    return await this.sessions.dismissCookieBanner(sessionId);
  }

  listEvents(sessionId: string, limit = 100) {
    return { events: this.eventStore.list(sessionId, limit) };
  }

  searchMemory(input: { taskIntent: string; siteDomain?: string; limit?: number }) {
    return { results: this.sessions.searchMemory(input) };
  }

  inspectMemory(insightId: string) {
    return this.sessions.inspectMemory(insightId);
  }

  verifyMemory(insightId: string) {
    return this.sessions.verifyMemory(insightId);
  }

  memoryStats() {
    return this.sessions.memoryStats();
  }

  cleanupSessions(input: { maxAgeDays?: number; dryRun?: boolean }) {
    return this.sessions.cleanupSessions(input);
  }
}
