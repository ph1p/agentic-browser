import fs from "node:fs";
import path from "node:path";

import type { Session } from "../lib/domain-schemas.js";

export interface StoredSessionRecord {
  session: Session;
  cdpUrl: string;
  targetWsUrl: string;
  pid: number;
  lastUrl?: string;
}

interface StoreState {
  activeSessionId?: string;
  sessions: Record<string, StoredSessionRecord>;
}

export class SessionStore {
  private readonly filePath: string;

  constructor(baseDir: string) {
    fs.mkdirSync(baseDir, { recursive: true });
    this.filePath = path.join(baseDir, "sessions.json");
    if (!fs.existsSync(this.filePath)) {
      this.write({ sessions: {} });
    }
  }

  getActive(): StoredSessionRecord | undefined {
    const state = this.read();
    if (!state.activeSessionId) {
      return undefined;
    }
    return state.sessions[state.activeSessionId];
  }

  get(sessionId: string): StoredSessionRecord | undefined {
    return this.read().sessions[sessionId];
  }

  list(): StoredSessionRecord[] {
    return Object.values(this.read().sessions);
  }

  save(record: StoredSessionRecord): void {
    const state = this.read();
    state.sessions[record.session.sessionId] = record;
    if (record.session.status !== "terminated") {
      state.activeSessionId = record.session.sessionId;
    }
    this.write(state);
  }

  setSession(session: Session): void {
    const state = this.read();
    const existing = state.sessions[session.sessionId];
    if (!existing) {
      throw new Error("Session not found in store");
    }

    state.sessions[session.sessionId] = { ...existing, session };
    if (session.status === "terminated" && state.activeSessionId === session.sessionId) {
      delete state.activeSessionId;
    }
    this.write(state);
  }

  clearActive(sessionId: string): void {
    const state = this.read();
    if (state.activeSessionId === sessionId) {
      delete state.activeSessionId;
      this.write(state);
    }
  }

  setLastUrl(sessionId: string, lastUrl: string): void {
    const state = this.read();
    const existing = state.sessions[sessionId];
    if (!existing) {
      throw new Error("Session not found in store");
    }
    state.sessions[sessionId] = { ...existing, lastUrl };
    this.write(state);
  }

  /** Remove all terminated sessions from the store. Returns the count removed. */
  purgeTerminated(): number {
    const state = this.read();
    const before = Object.keys(state.sessions).length;
    for (const [id, record] of Object.entries(state.sessions)) {
      if (record.session.status === "terminated" && id !== state.activeSessionId) {
        delete state.sessions[id];
      }
    }
    const removed = before - Object.keys(state.sessions).length;
    if (removed > 0) {
      this.write(state);
    }
    return removed;
  }

  replaceSessions(sessions: StoredSessionRecord[], activeSessionId?: string): void {
    const state: StoreState = {
      sessions: Object.fromEntries(sessions.map((record) => [record.session.sessionId, record])),
      activeSessionId,
    };
    this.write(state);
  }

  // Always read fresh from disk (never cache): the CLI and the MCP server are
  // separate processes sharing this file, so a cached snapshot would clobber the
  // other process's writes on the next whole-file write. These ops are
  // low-frequency (session lifecycle), so the extra read is negligible.
  private read(): StoreState {
    let raw: string;
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (error) {
      // Missing file is the expected first-run case — start empty. Any other
      // read error (e.g. transient EACCES) must NOT destroy existing state.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { sessions: {} };
      }
      throw error;
    }
    try {
      return JSON.parse(raw) as StoreState;
    } catch {
      // Genuinely unparseable content — back it up, then reset.
      try {
        fs.copyFileSync(this.filePath, `${this.filePath}.corrupt`);
      } catch {
        // best effort
      }
      const empty: StoreState = { sessions: {} };
      this.write(empty);
      return empty;
    }
  }

  private write(state: StoreState): void {
    // Atomic write: a concurrent reader in another process never sees a torn file.
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tmp, this.filePath);
  }
}
