import fs from "node:fs";
import { parseArgs } from "node:util";
import { runRelay } from "./relay-server.js";

// Relay daemon entry, spawned detached by the CDP client (see relay-client.ts).
const { values } = parseArgs({
  options: {
    "browser-ws": { type: "string" },
    socket: { type: "string" },
    "idle-ms": { type: "string" },
    log: { type: "string" },
  },
});

/** `0`, `never`, `infinity` disable the idle exit; unset/invalid falls back to 10 min. */
function parseIdleMs(raw: string | undefined): number {
  const value = raw?.trim().toLowerCase();
  if (value === "0" || value === "never" || value === "infinity") return Infinity;
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 10 * 60_000;
}

const browserWsUrl = values["browser-ws"];
const socketPath = values.socket;
const logFile = values.log;
const log = (message: string) => {
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${new Date().toISOString()} ${message}\n`, { mode: 0o600 });
  } catch {
    // logging is best effort
  }
};

if (!browserWsUrl || !socketPath) {
  process.stderr.write("usage: relay --browser-ws <url> --socket <path>\n");
  process.exit(2);
}

runRelay({
  browserWsUrl,
  socketPath,
  idleMs: parseIdleMs(values["idle-ms"]),
  log,
}).then(
  (relay) => {
    const shutdown = () => void relay.close().finally(() => process.exit(0));
    process.once("SIGTERM", shutdown);
    process.once("SIGINT", shutdown);
    void relay.closed.then(() => process.exit(0));
  },
  (error: unknown) => {
    log(`failed: ${(error as Error).message}`);
    process.exit(1);
  },
);
