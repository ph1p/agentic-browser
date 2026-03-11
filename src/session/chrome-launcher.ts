import fs from "node:fs";
import path from "node:path";

export interface ChromeLaunchResult {
  executablePath: string;
  profileDir: string;
  debugPort: number;
}

const CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium-browser",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
];

export function discoverChrome(explicitPath?: string): string {
  if (explicitPath && fs.existsSync(explicitPath)) {
    return explicitPath;
  }

  const found = CANDIDATES.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error("No supported Chrome installation found.");
  }
  return found;
}

export function launchChrome(
  executablePath: string,
  sessionId: string,
  baseDir: string,
): ChromeLaunchResult {
  return {
    executablePath,
    profileDir: path.join(baseDir, `profile-${sessionId}`),
    debugPort: 9222,
  };
}
