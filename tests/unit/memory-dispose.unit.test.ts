import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import { createMockAgenticBrowserCore } from "../../src/cli/runtime.js";
import { flushRegistrySize } from "../../src/lib/flush-registry.js";
import type { TaskInsight } from "../../src/memory/memory-schemas.js";
import { TaskInsightStore } from "../../src/memory/task-insight-store.js";

function makeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-memory-dispose-"));
}

function makeInsight(): TaskInsight {
  const now = new Date().toISOString();
  return {
    insightId: "ins-dispose-1",
    taskIntent: "interact:click:example.com",
    siteDomain: "example.com",
    sitePathPattern: "/",
    actionRecipe: [
      {
        type: "interact",
        summary: "interact:click",
        selector: "#go",
        payload: { action: "click", selector: "#go" },
      },
    ],
    expectedOutcome: "ok",
    confidence: 0.5,
    successCount: 1,
    failureCount: 0,
    useCount: 0,
    freshness: "fresh",
    staleStrikeCount: 0,
    selectorAliases: [],
    evidence: [],
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
  };
}

describe("memory store dispose", () => {
  it("drains the flush registry when cores are disposed", async () => {
    const dirs: string[] = [];
    const before = flushRegistrySize();

    const cores = Array.from({ length: 3 }, () => {
      const dir = makeDir();
      dirs.push(dir);
      return createMockAgenticBrowserCore({ ...process.env, AGENTIC_BROWSER_DIR: dir });
    });
    expect(flushRegistrySize()).toBe(before + 6);

    for (const core of cores) {
      await core.dispose();
      await core.dispose();
    }

    expect(flushRegistrySize()).toBe(before);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("flushes pending writes on dispose", () => {
    const dir = makeDir();
    const store = new TaskInsightStore(dir);
    store.upsert(makeInsight());
    store.dispose();

    const contents = fs.readFileSync(path.join(dir, "memory", "insights.json"), "utf8");
    expect(contents).toContain("ins-dispose-1");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("does not force exit on SIGINT when another handler exists", () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const dir = makeDir();
    const store = new TaskInsightStore(dir);
    const ownHandler = () => {};
    process.on("SIGINT", ownHandler);
    try {
      process.emit("SIGINT");
      expect(exitSpy).not.toHaveBeenCalled();
    } finally {
      process.off("SIGINT", ownHandler);
      store.dispose();
      exitSpy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
