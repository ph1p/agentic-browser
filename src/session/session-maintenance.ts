import fs from "node:fs";
import path from "node:path";

import type { BrowserController } from "./browser-controller.js";
import type { SessionStore, StoredSessionRecord } from "./session-store.js";

export interface CleanupInput {
  maxAgeDays?: number;
  dryRun?: boolean;
}

export interface CleanupResult {
  removedSessionIds: string[];
  removedProfileDirs: string[];
  keptActiveSessionId?: string;
  dryRun: boolean;
}

export function cleanupSessions(
  store: SessionStore,
  dataDir: string,
  input: CleanupInput,
): CleanupResult {
  const maxAgeDays = input.maxAgeDays ?? 7;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
    throw new Error("maxAgeDays must be a non-negative number");
  }

  const dryRun = input.dryRun ?? false;
  const now = Date.now();
  const cutoffMs = now - maxAgeDays * 24 * 60 * 60 * 1000;
  const active = store.getActive();
  const all = store.list();

  const removedSessionIds: string[] = [];
  const keep: StoredSessionRecord[] = [];

  for (const record of all) {
    const isActive = active?.session.sessionId === record.session.sessionId;
    if (isActive) {
      keep.push(record);
      continue;
    }

    if (record.session.status !== "terminated") {
      keep.push(record);
      continue;
    }

    const endedAt = record.session.endedAt ? Date.parse(record.session.endedAt) : Number.NaN;
    if (Number.isNaN(endedAt) || endedAt > cutoffMs) {
      keep.push(record);
      continue;
    }

    removedSessionIds.push(record.session.sessionId);
  }

  const keepIds = new Set(keep.map((record) => record.session.sessionId));
  const profilesDir = path.join(dataDir, "profiles");
  const removedProfileDirs: string[] = [];

  if (fs.existsSync(profilesDir)) {
    for (const entry of fs.readdirSync(profilesDir)) {
      const fullPath = path.join(profilesDir, entry);
      if (!fs.statSync(fullPath).isDirectory()) {
        continue;
      }
      if (keepIds.has(entry)) {
        continue;
      }
      removedProfileDirs.push(fullPath);
    }
  }

  if (!dryRun) {
    store.replaceSessions(keep, active?.session.sessionId);
    for (const profilePath of removedProfileDirs) {
      fs.rmSync(profilePath, { recursive: true, force: true });
    }
  }

  return {
    removedSessionIds,
    removedProfileDirs,
    keptActiveSessionId: active?.session.sessionId,
    dryRun,
  };
}

/** Quick health check — probe the CDP connection with a lightweight evaluate. */
export async function isSessionAlive(
  browser: BrowserController,
  record: StoredSessionRecord,
): Promise<boolean> {
  if (!record.targetWsUrl) return false;
  if (record.pid > 0) {
    try {
      process.kill(record.pid, 0); // signal 0 = existence check
    } catch (err: unknown) {
      // EPERM means the process exists but we can't signal it — still alive
      if ((err as NodeJS.ErrnoException).code === "EPERM") {
        // fall through to CDP check
      } else {
        return false; // ESRCH = process is gone
      }
    }
  }
  try {
    await browser.getContent(record.targetWsUrl, { mode: "title" });
    return true;
  } catch {
    return false;
  }
}
