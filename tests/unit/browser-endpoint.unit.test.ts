import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  pageWsUrl,
  readActivePort,
  targetIdOf,
} from "../../src/session/browser/browser-endpoint.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-endpoint-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("browser-endpoint", () => {
  it("reads port and browser path from DevToolsActivePort", () => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "9222\n/devtools/browser/abc-123\n");
    expect(readActivePort(dir)).toEqual({ port: 9222, browserPath: "/devtools/browser/abc-123" });
  });

  it("ignores missing or malformed DevToolsActivePort files", () => {
    const dir = tempDir();
    expect(readActivePort(dir)).toBeUndefined();
    fs.writeFileSync(path.join(dir, "DevToolsActivePort"), "nope\n");
    expect(readActivePort(dir)).toBeUndefined();
  });

  it("round-trips page target URLs", () => {
    const url = pageWsUrl("http://127.0.0.1:9222", "T1");
    expect(url).toBe("ws://127.0.0.1:9222/devtools/page/T1");
    expect(targetIdOf(url)).toBe("T1");
    expect(targetIdOf("ws://127.0.0.1:9222/devtools/browser/x")).toBeUndefined();
  });
});
