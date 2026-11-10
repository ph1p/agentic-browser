import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensurePrivateDir } from "../../lib/secure-fs.js";
import { isSocketAlive } from "../../relay/relay-server.js";

/** How long to wait for the relay; covers the user clicking Chrome's approval prompt. */
const RELAY_START_TIMEOUT_MS = 60_000;
const RELAY_POLL_MS = 100;

/** Built relay entry (dist/relay/index.mjs), located from any dist chunk. Absent in dev/tests. */
function relayScriptPath(): string | undefined {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  for (const rel of ["relay/index.mjs", "../relay/index.mjs"]) {
    const candidate = path.join(dir, rel);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function relayDisabled(): boolean {
  const flag = process.env.AGENTIC_BROWSER_RELAY?.toLowerCase();
  return process.platform === "win32" || flag === "0" || flag === "false";
}

/**
 * Socket path per browser instance. Lives in a private (0700) per-user dir under
 * the OS temp dir: unix socket paths are limited to ~104 bytes on macOS.
 */
export function relayPaths(browserWsUrl: string): { socket: string; log: string } {
  const uid = typeof process.getuid === "function" ? process.getuid() : "user";
  const dir = path.join(os.tmpdir(), `agentic-browser-${uid}`);
  ensurePrivateDir(dir);
  const hash = crypto.createHash("sha256").update(browserWsUrl).digest("hex").slice(0, 16);
  return {
    socket: path.join(dir, `relay-${hash}.sock`),
    log: path.join(dir, `relay-${hash}.log`),
  };
}

/**
 * WebSocket URL of a relay holding `browserWsUrl`, starting one if needed.
 * Returns undefined when the relay is unavailable; callers then connect directly.
 */
export async function ensureRelay(browserWsUrl: string): Promise<string | undefined> {
  if (relayDisabled()) return undefined;
  const script = relayScriptPath();
  if (!script) return undefined;

  const paths = relayPaths(browserWsUrl);
  const relayUrl = `ws+unix://${paths.socket}:/`;
  if (await isSocketAlive(paths.socket)) return relayUrl;

  const args = [script, "--browser-ws", browserWsUrl, "--socket", paths.socket, "--log", paths.log];
  const idleMs = process.env.AGENTIC_BROWSER_RELAY_IDLE_MS;
  if (idleMs) args.push("--idle-ms", idleMs);
  const child = spawn(process.execPath, args, { detached: true, stdio: "ignore" });
  child.unref();
  let exited = false;
  child.once("exit", () => {
    exited = true;
  });

  const deadline = Date.now() + RELAY_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await isSocketAlive(paths.socket)) return relayUrl;
    // A concurrent start may have won the socket; the check above covers it.
    if (exited) break;
    await new Promise((resolve) => setTimeout(resolve, RELAY_POLL_MS));
  }
  if (await isSocketAlive(paths.socket)) return relayUrl;
  if (!exited) child.kill();
  throw new Error(
    `CDP relay did not start (was the Chrome remote-debugging prompt allowed?). Log: ${paths.log}`,
  );
}
