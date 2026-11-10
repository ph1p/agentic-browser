import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Version from package.json; "0.0.0" if it cannot be read. */
export function readPackageVersion(): string {
  const dir = dirname(fileURLToPath(import.meta.url));
  // Works from src/ (dev) and from dist/ chunks at either depth (built).
  for (const rel of ["../../package.json", "../package.json"]) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, rel), "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      // try next
    }
  }
  return "0.0.0";
}
