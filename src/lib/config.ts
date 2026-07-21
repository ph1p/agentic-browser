import os from "node:os";
import path from "node:path";

export interface AppConfig {
  dataDir: string;
  browserExecutablePath?: string;
  cdpUrl?: string;
  userProfileDir?: string;
  headless?: boolean;
  userAgent?: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const userProfile = env.AGENTIC_BROWSER_USER_PROFILE;
  let userProfileDir: string | undefined;
  if (userProfile === "true" || userProfile === "default") {
    userProfileDir = "default";
  } else if (userProfile && path.isAbsolute(userProfile)) {
    userProfileDir = userProfile;
  }

  return {
    dataDir: env.AGENTIC_BROWSER_DIR ?? path.join(os.homedir(), ".agentic-browser"),
    browserExecutablePath:
      env.AGENTIC_BROWSER_CHROME_EXECUTABLE_PATH ?? env.AGENTIC_BROWSER_CHROME_PATH,
    cdpUrl: env.AGENTIC_BROWSER_CDP_URL,
    userProfileDir,
    headless: env.AGENTIC_BROWSER_HEADLESS === "true" || env.AGENTIC_BROWSER_HEADLESS === "1",
    userAgent: env.AGENTIC_BROWSER_USER_AGENT || undefined,
  };
}
