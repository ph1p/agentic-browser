import fs from "node:fs";
import path from "node:path";

import type { SessionEvent } from "../lib/domain-schemas.js";

export class EventStore {
  private readonly events = new Map<string, SessionEvent[]>();
  private readonly filePath: string;

  constructor(private readonly baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, "session-events.log");
  }

  append(event: SessionEvent): void {
    const existing = this.events.get(event.sessionId) ?? [];
    existing.push(event);
    this.events.set(event.sessionId, existing);
    fs.appendFile(this.filePath, `${JSON.stringify(event)}\n`, "utf8", () => {});
  }

  list(sessionId: string, limit = 100): SessionEvent[] {
    const entries = this.events.get(sessionId) ?? [];
    return entries.slice(Math.max(0, entries.length - limit));
  }
}
