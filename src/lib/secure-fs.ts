import fs from "node:fs";

export const PRIVATE_DIR_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

/** Create a directory (recursively) with owner-only permissions. Mode applies only to dirs it creates. */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
}

/** Write a file with owner-only permissions, tightening any pre-existing file. */
export function writePrivateFileSync(file: string, data: string): void {
  fs.writeFileSync(file, data, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  fs.chmodSync(file, PRIVATE_FILE_MODE);
}
