import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { agentNavigate, agentStart } from "../../src/cli/commands/agent.js";
import { createAgenticBrowserCore } from "../../src/cli/runtime.js";
import { ensurePrivateDir, writePrivateFileSync } from "../../src/lib/secure-fs.js";
import { MockBrowserController } from "../../src/session/browser-controller.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-perms-"));
  tempDirs.push(dir);
  return dir;
}

function walk(dir: string, skip: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (full !== skip) {
        out.push(...walk(full, skip));
      }
    } else if (entry.isFile()) {
      out.push(full);
    }
  }
  return out;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe.skipIf(process.platform === "win32")("private file permissions", () => {
  it("state dirs and files created by a session are owner-only", async () => {
    const dir = makeTempDir();
    const runtime = createAgenticBrowserCore({
      env: { ...process.env, AGENTIC_BROWSER_DIR: dir },
      browserController: new MockBrowserController(),
    });
    await agentStart(runtime);
    await agentNavigate(runtime, { url: "https://example.com" });
    // Let debounced memory/event flushes happen.
    await new Promise((resolve) => setTimeout(resolve, 1200));

    const memoryDir = path.join(dir, "memory");
    expect(fs.existsSync(memoryDir)).toBe(true);
    expect(fs.statSync(memoryDir).mode & 0o077).toBe(0);

    const files = walk(dir, path.join(dir, "profiles"));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(fs.statSync(file).mode & 0o077, file).toBe(0);
    }
  });

  it("writePrivateFileSync tightens a pre-existing 0644 file", () => {
    const file = path.join(makeTempDir(), "state.json");
    fs.writeFileSync(file, "old", { mode: 0o644 });
    fs.chmodSync(file, 0o644);

    writePrivateFileSync(file, "new");

    expect(fs.readFileSync(file, "utf8")).toBe("new");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  });

  it("ensurePrivateDir creates a nested dir with mode 0700", () => {
    const leaf = path.join(makeTempDir(), "a", "b");

    ensurePrivateDir(leaf);

    expect(fs.statSync(leaf).mode & 0o777).toBe(0o700);
  });
});
