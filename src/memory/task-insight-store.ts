import fs from "node:fs";
import path from "node:path";

import {
  MemoryStateSchema,
  TaskInsightSchema,
  type MemoryState,
  type TaskInsight,
} from "./memory-schemas.js";

const EMPTY_STATE: MemoryState = { insights: [] };
const FLUSH_DELAY_MS = 500;

export class TaskInsightStore {
  private readonly filePath: string;

  /** In-memory cache – authoritative after first load. */
  private cached: TaskInsight[] | null = null;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(baseDir: string) {
    const memoryDir = path.join(baseDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    this.filePath = path.join(memoryDir, "insights.json");

    // Clean up orphaned .tmp files from interrupted writes
    const tmpPath = `${this.filePath}.tmp`;
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failures
    }

    if (!fs.existsSync(this.filePath)) {
      this.writeDisk(EMPTY_STATE);
    }

    // Flush pending writes on exit
    const onExit = () => this.flushSync();
    process.on("exit", onExit);
    process.on("SIGINT", () => { this.flushSync(); process.exit(0); });
    process.on("SIGTERM", () => { this.flushSync(); process.exit(0); });
  }

  list(): TaskInsight[] {
    return this.getCache();
  }

  get(insightId: string): TaskInsight | undefined {
    return this.getCache().find((insight) => insight.insightId === insightId);
  }

  upsert(insight: TaskInsight): void {
    // Validate only on external mutations (not internal read cycles)
    TaskInsightSchema.parse(insight);

    const insights = this.getCache();
    const index = insights.findIndex((entry) => entry.insightId === insight.insightId);
    if (index >= 0) {
      insights[index] = insight;
    } else {
      insights.push(insight);
    }
    this.markDirty();
  }

  replaceMany(insights: TaskInsight[]): void {
    for (const insight of insights) {
      TaskInsightSchema.parse(insight);
    }
    this.cached = insights;
    this.markDirty();
  }

  /** Force an immediate synchronous flush (used at shutdown). */
  flushSync(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty && this.cached) {
      this.writeDisk({ insights: this.cached });
      this.dirty = false;
    }
  }

  // ── private ──────────────────────────────────────────────────────

  /** Return the in-memory cache, loading from disk on first access. */
  private getCache(): TaskInsight[] {
    if (this.cached) return this.cached;
    const state = this.readDisk();
    this.cached = state.insights;
    return this.cached;
  }

  private markDirty(): void {
    this.dirty = true;
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = null;
        this.flushSync();
      }, FLUSH_DELAY_MS);
      // Allow the Node process to exit even if the timer is pending
      if (this.flushTimer && typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
        this.flushTimer.unref();
      }
    }
  }

  /** Read and validate from disk (only on first load or corruption recovery). */
  private readDisk(): MemoryState {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
    } catch {
      this.backupAndReset();
      return EMPTY_STATE;
    }

    try {
      return MemoryStateSchema.parse(raw);
    } catch {
      const obj = raw as { insights?: unknown[] };
      if (Array.isArray(obj?.insights)) {
        const salvaged = obj.insights.filter((item) => TaskInsightSchema.safeParse(item).success);
        if (salvaged.length > 0) {
          const state: MemoryState = { insights: salvaged as TaskInsight[] };
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

  private writeDisk(state: MemoryState): void {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tempPath, this.filePath);
  }
}
