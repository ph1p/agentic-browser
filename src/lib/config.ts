import path from "node:path";

export interface AppConfig {
  host: string;
  wsPort: number;
  logDir: string;
  browserExecutablePath?: string;
  commandTimeoutMs: number;
}

const DEFAULT_PORT = 43111;
const DEFAULT_TIMEOUT_MS = 2_000;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const wsPort = Number.parseInt(env.AGENTIC_BROWSER_WS_PORT ?? `${DEFAULT_PORT}`, 10);
  const commandTimeoutMs = Number.parseInt(
    env.AGENTIC_BROWSER_COMMAND_TIMEOUT_MS ?? `${DEFAULT_TIMEOUT_MS}`,
    10,
  );

  if (Number.isNaN(wsPort) || wsPort <= 0) {
    throw new Error("AGENTIC_BROWSER_WS_PORT must be a positive integer");
  }
  if (Number.isNaN(commandTimeoutMs) || commandTimeoutMs <= 0) {
    throw new Error("AGENTIC_BROWSER_COMMAND_TIMEOUT_MS must be a positive integer");
  }

  return {
    host: env.AGENTIC_BROWSER_HOST ?? "127.0.0.1",
    wsPort,
    commandTimeoutMs,
    logDir: env.AGENTIC_BROWSER_LOG_DIR ?? path.resolve(process.cwd(), ".agentic-browser"),
    browserExecutablePath: env.AGENTIC_BROWSER_CHROME_PATH,
  };
}
