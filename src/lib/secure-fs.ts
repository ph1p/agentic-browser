import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/**
 * Create a directory (recursively) and tighten it to owner-only if it already existed
 * with wider permissions (skips home, filesystem root, and dirs owned by another user).
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  try {
    if (process.platform === "win32" || typeof process.getuid !== "function") {
      return;
    }
    const resolved = path.resolve(dir);
    if (resolved === path.parse(resolved).root || resolved === path.resolve(os.homedir())) {
      return;
    }
    const st = fs.statSync(resolved);
    if (!st.isDirectory() || st.uid !== process.getuid()) {
      return;
    }
    if ((st.mode & 0o077) !== 0) {
      fs.chmodSync(resolved, PRIVATE_DIR_MODE);
    }
  } catch {
    // Best effort: never fail because the directory could not be tightened.
  }
}

/** Write a file with owner-only permissions, tightening any pre-existing file. */
export function writePrivateFileSync(file: string, data: string): void {
  fs.writeFileSync(file, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  fs.chmodSync(file, PRIVATE_FILE_MODE);
}
