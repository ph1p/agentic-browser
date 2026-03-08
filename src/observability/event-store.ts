import fs from "node:fs";
import path from "node:path";

import type { SessionEvent } from "../lib/domain-schemas.js";

const MAX_EVENTS_PER_SESSION = 500;

export class EventStore {
  private readonly events = new Map<string, SessionEvent[]>();
  private readonly filePath: string;

  constructor(baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, "session-events.log");
  }

  append(event: SessionEvent): void {
    let existing = this.events.get(event.sessionId) ?? [];
    existing.push(event);
    if (existing.length > MAX_EVENTS_PER_SESSION) {
      existing = existing.slice(-MAX_EVENTS_PER_SESSION);
    }
    this.events.set(event.sessionId, existing);
    fs.appendFileSync(this.filePath, `${JSON.stringify(event)}\n`, "utf8");
  }

  list(sessionId: string, limit = 100): SessionEvent[] {
    const entries = this.events.get(sessionId) ?? [];
    return entries.slice(Math.max(0, entries.length - limit));
  }

  clear(sessionId: string): void {
    this.events.delete(sessionId);
  }
}
