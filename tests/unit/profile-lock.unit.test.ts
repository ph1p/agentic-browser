import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isProfileLocked } from "../../src/session/browser-controller.js";

describe.skipIf(process.platform === "win32")("isProfileLocked", () => {
  let dir: string;
  let lock: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ab-lock-"));
    lock = path.join(dir, "SingletonLock");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns unlocked when no lock file exists", () => {
    expect(isProfileLocked(dir)).toEqual({ locked: false });
  });

  it("detects a dangling symlink pointing at a live pid", () => {
    fs.symlinkSync(`host-${process.pid}`, lock);
    expect(isProfileLocked(dir)).toEqual({ locked: true, pid: process.pid });
  });

  it("treats a symlink to a dead pid as stale", (ctx) => {
    const deadPid = 999999;
    try {
      process.kill(deadPid, 0);
      ctx.skip();
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
        ctx.skip();
        return;
      }
    }
    fs.symlinkSync(`host-${deadPid}`, lock);
    expect(isProfileLocked(dir).locked).toBe(false);
  });

  it("treats a regular file as locked", () => {
    fs.writeFileSync(lock, "");
    expect(isProfileLocked(dir)).toEqual({ locked: true });
  });
});
