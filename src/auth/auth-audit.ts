import crypto from "node:crypto";

import type { EventStore } from "../observability/event-store.js";

export class AuthAuditService {
  constructor(private readonly events: EventStore) {}

  recordRejectedAttempt(sessionId: string, reason: string): void {
    this.events.append({
      eventId: crypto.randomUUID(),
      sessionId,
      category: "security",
      severity: "warning",
      message: `Unauthorized command rejected: ${reason}`,
      createdAt: new Date().toISOString(),
    });
  }
}
