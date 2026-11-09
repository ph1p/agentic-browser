import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  createMockAgenticBrowserCore,
  type AgenticBrowserCore,
  type Runtime,
} from "../../src/cli/runtime.js";

const created: Array<{ core: AgenticBrowserCore; dir: string }> = [];

/** Mock-backed runtime in a fresh temp dir; cleaned up by `disposeTestRuntimes`. */
export function createDefaultRuntime(): Runtime {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-test-"));
  const core = createMockAgenticBrowserCore({ ...process.env, AGENTIC_BROWSER_DIR: dir });
  created.push({ core, dir });
  return core;
}

export async function disposeTestRuntimes(): Promise<void> {
  const items = created.splice(0);
  for (const { core, dir } of items) {
    await core.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
