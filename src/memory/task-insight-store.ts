import fs from "node:fs";
import path from "node:path";

import {
  MemoryStateSchema,
  TaskInsightSchema,
  type MemoryState,
  type TaskInsight,
} from "./memory-schemas.js";

const EMPTY_STATE: MemoryState = { insights: [] };

export class TaskInsightStore {
  private readonly filePath: string;

  constructor(baseDir: string) {
    const memoryDir = path.join(baseDir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    this.filePath = path.join(memoryDir, "insights.json");

    // B3: Clean up orphaned .tmp files from interrupted writes
    const tmpPath = `${this.filePath}.tmp`;
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore cleanup failures
    }

    if (!fs.existsSync(this.filePath)) {
      this.write(EMPTY_STATE);
    }
  }

  list(): TaskInsight[] {
    return this.read().insights;
  }

  get(insightId: string): TaskInsight | undefined {
    return this.read().insights.find((insight) => insight.insightId === insightId);
  }

  upsert(insight: TaskInsight): void {
    TaskInsightSchema.parse(insight);
    const state = this.read();
    const index = state.insights.findIndex((entry) => entry.insightId === insight.insightId);
    if (index >= 0) {
      state.insights[index] = insight;
    } else {
      state.insights.push(insight);
    }
    this.write(state);
  }

  replaceMany(insights: TaskInsight[]): void {
    for (const insight of insights) {
      TaskInsightSchema.parse(insight);
    }
    this.write({ insights });
  }

  private read(): MemoryState {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as unknown;
    } catch {
      // JSON parse failure – file is truly corrupt, nothing to salvage
      this.backupAndReset();
      return EMPTY_STATE;
    }

    try {
      return MemoryStateSchema.parse(raw);
    } catch {
      // Zod validation failed – try to salvage individual insights
      const obj = raw as { insights?: unknown[] };
      if (Array.isArray(obj?.insights)) {
        const salvaged = obj.insights.filter((item) => TaskInsightSchema.safeParse(item).success);
        if (salvaged.length > 0) {
          const state: MemoryState = { insights: salvaged as TaskInsight[] };
          this.backupAndReset();
          this.write(state);
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

  private write(state: MemoryState): void {
    const tempPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), "utf8");
    fs.renameSync(tempPath, this.filePath);
  }
}
