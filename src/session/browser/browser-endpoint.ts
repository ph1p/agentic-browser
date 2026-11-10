import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Locating the browser-level DevTools WebSocket of a Chrome we did not launch.
 *
 * Chrome 144+ can expose remote debugging for the user's normal profile via
 * chrome://inspect/#remote-debugging. That mode serves only the browser
 * WebSocket: the HTTP /json/* endpoints answer 404 and per-page
 * /devtools/page/<id> sockets are refused. The browser socket path is
 * published in `<user-data-dir>/DevToolsActivePort` (line 1: port, line 2: path).
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]", "::1"]);

/** User-data dirs of Chromium-based browsers that may write DevToolsActivePort. */
export function candidateUserDataDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "darwin") {
    const base = path.join(home, "Library", "Application Support");
    return [
      "Google/Chrome",
      "Google/Chrome Beta",
      "Google/Chrome Dev",
      "Google/Chrome Canary",
      "Chromium",
      "BraveSoftware/Brave-Browser",
      "Microsoft Edge",
    ].map((dir) => path.join(base, dir));
  }
  if (process.platform === "win32") {
    const base = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [
      "Google/Chrome/User Data",
      "Google/Chrome Beta/User Data",
      "Google/Chrome SxS/User Data",
      "Chromium/User Data",
      "BraveSoftware/Brave-Browser/User Data",
      "Microsoft/Edge/User Data",
    ].map((dir) => path.join(base, dir));
  }
  const base = process.env.XDG_CONFIG_HOME ?? path.join(home, ".config");
  return [
    "google-chrome",
    "google-chrome-beta",
    "google-chrome-unstable",
    "chromium",
    "BraveSoftware/Brave-Browser",
    "microsoft-edge",
  ].map((dir) => path.join(base, dir));
}

export interface ActivePort {
  port: number;
  /** Browser WebSocket path, e.g. `/devtools/browser/<uuid>`. */
  browserPath: string;
}

export function readActivePort(userDataDir: string): ActivePort | undefined {
  try {
    const [portLine, pathLine] = fs
      .readFileSync(path.join(userDataDir, "DevToolsActivePort"), "utf8")
      .split("\n");
    const port = Number.parseInt(portLine ?? "", 10);
    const browserPath = pathLine?.trim();
    if (!port || !browserPath?.startsWith("/devtools/browser/")) return undefined;
    return { port, browserPath };
  } catch {
    return undefined;
  }
}

/** All DevToolsActivePort entries found on this machine (stale files included). */
export function listActivePorts(): ActivePort[] {
  return candidateUserDataDirs()
    .map(readActivePort)
    .filter((entry): entry is ActivePort => entry !== undefined);
}

export interface BrowserEndpoint {
  url: string;
  /**
   * `http`: classic --remote-debugging-port. `active-port`: found only via
   * DevToolsActivePort (chrome://inspect mode; each new connection may prompt).
   */
  source: "http" | "active-port";
}

/**
 * Browser WebSocket URL for a DevTools host (`host:port`). Prefers
 * /json/version; falls back to a local DevToolsActivePort with a matching port.
 */
export async function resolveBrowserWsUrl(hostPort: string): Promise<BrowserEndpoint | undefined> {
  try {
    const response = await fetch(`http://${hostPort}/json/version`, {
      signal: AbortSignal.timeout(2000),
    });
    if (response.ok) {
      const payload = (await response.json()) as { webSocketDebuggerUrl?: string };
      if (payload.webSocketDebuggerUrl)
        return { url: payload.webSocketDebuggerUrl, source: "http" };
    }
  } catch {
    // no HTTP endpoints — try DevToolsActivePort
  }
  const { hostname, port } = new URL(`http://${hostPort}`);
  if (!LOOPBACK_HOSTS.has(hostname)) return undefined;
  const match = listActivePorts().find((entry) => String(entry.port) === port);
  return match ? { url: `ws://${hostPort}${match.browserPath}`, source: "active-port" } : undefined;
}

/** `host:port` of a CDP URL (http(s):// or ws(s)://). */
export function hostPortOf(cdpUrl: string): string {
  return new URL(cdpUrl).host;
}

/** Page WebSocket URL for a target id; the canonical target address used everywhere. */
export function pageWsUrl(cdpUrl: string, targetId: string): string {
  return `ws://${hostPortOf(cdpUrl)}/devtools/page/${targetId}`;
}

/** Target id from a /devtools/page/<id> URL. */
export function targetIdOf(targetWsUrl: string): string | undefined {
  return /\/devtools\/page\/([^/?#]+)/.exec(targetWsUrl)?.[1];
}
