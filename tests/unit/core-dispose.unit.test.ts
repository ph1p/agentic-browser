import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { createMockAgenticBrowserCore } from "../../src/cli/runtime.js";

describe("core dispose", () => {
  it("releases process listeners added by event stores", async () => {
    const dirs: string[] = [];
    const beforeExitBefore = process.listenerCount("beforeExit");

    const cores = Array.from({ length: 3 }, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-dispose-"));
      dirs.push(dir);
      return createMockAgenticBrowserCore({ ...process.env, AGENTIC_BROWSER_DIR: dir });
    });
    expect(process.listenerCount("beforeExit")).toBe(beforeExitBefore + 3);

    for (const core of cores) {
      await core.dispose();
      await core.dispose();
    }

    expect(process.listenerCount("beforeExit")).toBe(beforeExitBefore);
    for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  });
});
