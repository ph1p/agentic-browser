import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { CdpConnection, type CdpTarget } from "./cdp-connection.js";
import { hostPortOf, pageWsUrl } from "./browser-endpoint.js";

/**
 * Detect a running Chrome that owns `profileDir`. On macOS/Linux `SingletonLock`
 * is a dangling symlink to `<hostname>-<pid>`, so existsSync (which follows
 * symlinks) cannot see it; inspect the link itself and probe the pid.
 */
export function isProfileLocked(profileDir: string): { locked: boolean; pid?: number } {
  const lockFile = path.join(profileDir, "SingletonLock");
  let target: string;
  try {
    const st = fs.lstatSync(lockFile);
    if (!st.isSymbolicLink()) return { locked: true }; // unknown format: be conservative
    target = fs.readlinkSync(lockFile);
  } catch {
    return { locked: false }; // ENOENT
  }
  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 0) return { locked: true };
  try {
    process.kill(pid, 0);
    return { locked: true, pid };
  } catch (e) {
    // EPERM: process exists under another user. ESRCH: stale lock, Chrome clears it.
    return { locked: (e as NodeJS.ErrnoException).code === "EPERM", pid };
  }
}

export async function getJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return (await response.json()) as T;
}

/** Debugger connection timing */
export const DEBUGGER_READY_TIMEOUT_MS = 15_000;
export const DEBUGGER_INITIAL_RETRY_DELAY_MS = 50;
export const DEBUGGER_MAX_RETRY_DELAY_MS = 250;

/** Check if the debug port is accepting TCP connections (faster than an HTTP fetch). */
export function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export async function waitForDebugger(port: number): Promise<void> {
  const start = Date.now();
  let delay = DEBUGGER_INITIAL_RETRY_DELAY_MS;

  while (Date.now() - start < DEBUGGER_READY_TIMEOUT_MS) {
    // Quick TCP probe first — much cheaper than an HTTP round-trip.
    if (await probePort(port)) {
      // Port is open; confirm the HTTP endpoint is actually responding.
      try {
        await getJson(`http://127.0.0.1:${port}/json/version`);
        return;
      } catch {
        // Port open but HTTP not ready yet — keep waiting.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, DEBUGGER_MAX_RETRY_DELAY_MS);
  }
  throw new Error("Chrome debug endpoint did not become ready in time");
}

export async function ensurePageWebSocketUrl(cdpUrl: string): Promise<string> {
  const targets = await getJson<CdpTarget[]>(`${cdpUrl}/json/list`);
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error("No debuggable page target available");
  }
  return page.webSocketDebuggerUrl;
}

/**
 * Page target for a session. A browser we launched reuses its first (blank)
 * tab; a browser we connect to is the user's, so we always open our own tab
 * and never take over one of theirs.
 */
export async function createTarget(
  cdpUrl: string,
  { reuseExisting }: { reuseExisting: boolean },
  url = "about:blank",
): Promise<string> {
  if (reuseExisting) {
    try {
      return await ensurePageWebSocketUrl(cdpUrl);
    } catch {
      // fall through to creating a target when no page exists yet
    }
  }

  const endpoint = `${cdpUrl}/json/new?${encodeURIComponent(url)}`;
  const methods: Array<"PUT" | "GET"> = ["PUT", "GET"];
  for (const method of methods) {
    try {
      const response = await fetch(endpoint, { method });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as CdpTarget;
      if (payload.webSocketDebuggerUrl) {
        return payload.webSocketDebuggerUrl;
      }
    } catch {
      // try next method
    }
  }
  if (reuseExisting) return await ensurePageWebSocketUrl(cdpUrl);
  // No HTTP endpoints (chrome://inspect remote debugging): ask the browser socket.
  try {
    const { targetId } = await CdpConnection.sendBrowserCommand<{ targetId: string }>(
      hostPortOf(cdpUrl),
      "Target.createTarget",
      { url },
    );
    return pageWsUrl(cdpUrl, targetId);
  } catch (error) {
    throw new Error(`Unable to open a new tab via ${cdpUrl}: ${(error as Error).message}`, {
      cause: error,
    });
  }
}

export async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export function resolveDefaultProfileDir(): string {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
    );
  }
  // linux and others
  return path.join(home, ".config", "google-chrome");
}
