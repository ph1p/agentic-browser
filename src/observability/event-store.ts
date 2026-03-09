import fs from "node:fs";
import path from "node:path";

import type { SessionEvent } from "../lib/domain-schemas.js";

const MAX_EVENTS_PER_SESSION = 500;

export class EventStore {
  private readonly events = new Map<string, SessionEvent[]>();
  private readonly filePath: string;
  private readonly bufferedLines: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private flushInFlight: Promise<void> | undefined;

  constructor(baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, "session-events.log");
    process.once("beforeExit", this.flushSync);
    process.once("exit", this.flushSync);
  }

  append(event: SessionEvent): void {
    let existing = this.events.get(event.sessionId) ?? [];
    existing.push(event);
    if (existing.length > MAX_EVENTS_PER_SESSION) {
      existing = existing.slice(-MAX_EVENTS_PER_SESSION);
    }
    this.events.set(event.sessionId, existing);
    this.bufferedLines.push(`${JSON.stringify(event)}\n`);
    if (this.bufferedLines.length >= 20) {
      void this.flushSoon(0);
      return;
    }
    void this.flushSoon(25);
  }

  list(sessionId: string, limit = 100): SessionEvent[] {
    const entries = this.events.get(sessionId) ?? [];
    return entries.slice(Math.max(0, entries.length - limit));
  }

  clear(sessionId: string): void {
    this.events.delete(sessionId);
  }

  private flushSoon(delayMs: number): Promise<void> {
    if (this.flushInFlight) {
      return this.flushInFlight;
    }
    if (this.flushTimer) {
      return Promise.resolve();
    }

    this.flushTimer = setTimeout(() => {
      this.flushTimer = undefined;
      void this.flushAsync();
    }, delayMs);
    this.flushTimer.unref();
    return Promise.resolve();
  }

  private async flushAsync(): Promise<void> {
    if (this.flushInFlight || this.bufferedLines.length === 0) {
      return;
    }

    const chunk = this.bufferedLines.splice(0, this.bufferedLines.length).join("");
    this.flushInFlight = fs.promises
      .appendFile(this.filePath, chunk, "utf8")
      .catch(() => {})
      .finally(() => {
        this.flushInFlight = undefined;
        if (this.bufferedLines.length > 0) {
          void this.flushSoon(0);
        }
      });

    await this.flushInFlight;
  }

  private readonly flushSync = (): void => {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
    if (this.bufferedLines.length === 0) {
      return;
    }

    const chunk = this.bufferedLines.splice(0, this.bufferedLines.length).join("");
    try {
      fs.appendFileSync(this.filePath, chunk, "utf8");
    } catch {
      // ignore flush failures during shutdown
    }
  };
}
