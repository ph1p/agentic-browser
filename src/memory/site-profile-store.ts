import fs from "node:fs";
import path from "node:path";

import {
  SiteProfileSchema,
  SiteProfileStateSchema,
  type SiteProfile,
  type SiteProfileState,
} from "./memory-schemas.js";

const EMPTY_STATE: SiteProfileState = { profiles: [] };
const FLUSH_DELAY_MS = 500;
const REGISTERED_EXIT_HANDLERS = Symbol.for("agentic-browser.site-profile-store.exit-handlers");
const REGISTERED_STORES = Symbol.for("agentic-browser.site-profile-store.instances");

interface ProcessWithSiteProfileRegistry extends NodeJS.Process {
  [REGISTERED_EXIT_HANDLERS]?: boolean;
  [REGISTERED_STORES]?: Set<SiteProfileStore>;
}

export class SiteProfileStore {
  private readonly filePath: string;
  private cached: SiteProfile[] | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseDir: string) {
    const memoryDir = path.join(baseDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
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

    this.registerProcessHandlers();
  }

  list(): SiteProfile[] {
    return this.getCache();
  }

  get(domain: string): SiteProfile | undefined {
    const normalized = domain.toLowerCase();
    return this.getCache().find((p) => p.domain === normalized);
  }

  upsert(profile: SiteProfile): void {
    SiteProfileSchema.parse(profile);
    const profiles = this.getCache();
    const index = profiles.findIndex((p) => p.domain === profile.domain);
    if (index >= 0) {
      profiles[index] = profile;
    } else {
      profiles.push(profile);
    }
    this.markDirty();
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
        const salvaged = obj.profiles.filter((item) => SiteProfileSchema.safeParse(item).success);
        if (salvaged.length > 0) {
          const state: SiteProfileState = { profiles: salvaged as SiteProfile[] };
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
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tempPath, this.filePath);
  }

  private registerProcessHandlers(): void {
    const proc = process as ProcessWithSiteProfileRegistry;
    const stores = (proc[REGISTERED_STORES] ??= new Set<SiteProfileStore>());
    stores.add(this);

    if (proc[REGISTERED_EXIT_HANDLERS]) {
      return;
    }

    proc[REGISTERED_EXIT_HANDLERS] = true;

    const flushAll = () => {
      for (const store of stores) {
        store.flushSync();
      }
    };

    process.on("exit", flushAll);
    process.on("SIGINT", () => {
      flushAll();
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      flushAll();
      process.exit(0);
    });
  }
}
