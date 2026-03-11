import os from "node:os";
import path from "node:path";

export interface AppConfig {
  host: string;
  wsPort: number;
  dataDir: string;
  browserExecutablePath?: string;
  commandTimeoutMs: number;
  cdpUrl?: string;
  userProfileDir?: string;
  headless?: boolean;
  userAgent?: string;
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

  const userProfile = env.AGENTIC_BROWSER_USER_PROFILE;
  let userProfileDir: string | undefined;
  if (userProfile === "true" || userProfile === "default") {
    userProfileDir = "default";
  } else if (userProfile && path.isAbsolute(userProfile)) {
    userProfileDir = userProfile;
  }

  return {
    host: env.AGENTIC_BROWSER_HOST ?? "127.0.0.1",
    wsPort,
    commandTimeoutMs,
    dataDir: env.AGENTIC_BROWSER_DIR ?? path.join(os.homedir(), ".agentic-browser"),
    browserExecutablePath:
      env.AGENTIC_BROWSER_CHROME_EXECUTABLE_PATH ?? env.AGENTIC_BROWSER_CHROME_PATH,
    cdpUrl: env.AGENTIC_BROWSER_CDP_URL,
    userProfileDir,
    headless: env.AGENTIC_BROWSER_HEADLESS === "true" || env.AGENTIC_BROWSER_HEADLESS === "1",
    userAgent: env.AGENTIC_BROWSER_USER_AGENT || undefined,
  };
}
