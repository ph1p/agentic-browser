import fs from "node:fs";
import path from "node:path";

import { registerFlushable } from "../lib/flush-registry.js";
import { ensurePrivateDir, writePrivateFileSync } from "../lib/secure-fs.js";
import {
  SiteProfileSchema,
  SiteProfileStateSchema,
  type SiteProfile,
  type SiteProfileState,
} from "./memory-schemas.js";

const EMPTY_STATE: SiteProfileState = { profiles: [] };
const FLUSH_DELAY_MS = 500;

export class SiteProfileStore {
  private readonly filePath: string;
  private cached: SiteProfile[] | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly unregister: () => void;

  constructor(baseDir: string) {
    const memoryDir = path.join(baseDir, "memory");
    ensurePrivateDir(memoryDir);
    this.filePath = path.join(memoryDir, "site-profiles.json");

    const tmpPath = `${this.filePath}.tmp`;
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failures
    }

    if (!fs.existsSync(this.filePath)) {
      this.writeDisk(EMPTY_STATE);
    }

    this.unregister = registerFlushable(this);
  }

  list(): SiteProfile[] {
    return this.getCache();
  }

  get(domain: string): SiteProfile | undefined {
    const normalized = domain.toLowerCase();
    return this.getCache().find((p) => p.domain === normalized);
  }

  upsert(profile: SiteProfile): void {
    // Normalize the key so upsert and get() agree — get() lowercases the lookup,
    // so storing a mixed-case domain here would make it permanently unfindable
    // and append a duplicate row on every write.
    const normalized: SiteProfile = { ...profile, domain: profile.domain.toLowerCase() };
    SiteProfileSchema.parse(normalized);
    const profiles = this.getCache();
    const index = profiles.findIndex((p) => p.domain === normalized.domain);
    if (index >= 0) {
      profiles[index] = normalized;
    } else {
      profiles.push(normalized);
    }
    this.markDirty();
  }

  /** Flush pending writes and stop flushing on process exit. Idempotent. */
  dispose(): void {
    this.flushSync();
    this.unregister();
  }

  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty && this.cached) {
      this.writeDisk({ profiles: this.cached });
      this.dirty = false;
    }
  }

  // ── private ──────────────────────────────────────────────────────

  private getCache(): SiteProfile[] {
    if (this.cached) return this.cached;
    const state = this.readDisk();
    this.cached = state.profiles;
    return this.cached;
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushSync();
      }, FLUSH_DELAY_MS);
    }
  }

  private readDisk(): SiteProfileState {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
    } catch {
      this.backupAndReset();
      return EMPTY_STATE;
    }

    try {
      return SiteProfileStateSchema.parse(raw);
    } catch {
      const obj = raw as { profiles?: unknown[] };
      if (Array.isArray(obj?.profiles)) {
        // Keep the PARSED output so schema defaults (visitCount, …) are applied
        // — keeping the raw item would leave defaulted fields undefined.
        const salvaged = obj.profiles
          .map((item) => SiteProfileSchema.safeParse(item))
          .filter((result) => result.success)
          .map((result) => result.data);
        if (salvaged.length > 0) {
          const state: SiteProfileState = { profiles: salvaged };
          this.backupAndReset();
          this.writeDisk(state);
          return state;
        }
      }
      this.backupAndReset();
      return EMPTY_STATE;
    }
  }

  private backupAndReset(): void {
    const corruptPath = `${this.filePath}.corrupt-${Date.now()}`;
    try {
      fs.copyFileSync(this.filePath, corruptPath);
    } catch {
      // ignore backup failures
    }
  }

  private writeDisk(state: SiteProfileState): void {
    const tempPath = `${this.filePath}.tmp`;
    writePrivateFileSync(tempPath, JSON.stringify(state, null, 2));
    fs.renameSync(tempPath, this.filePath);
  }
}
