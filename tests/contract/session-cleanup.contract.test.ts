import { describe, expect, it } from "vitest";

import { ControlApi } from "../../src/transport/control-api.js";
import { createAppContext } from "../../src/cli/app.js";
import { SessionManager } from "../../src/session/session-manager.js";
import { MockBrowserController } from "../../src/session/browser-controller.js";

function createApi() {
  const context = createAppContext({
    ...process.env,
    AGENTIC_BROWSER_LOG_DIR: `/tmp/agentic-browser-cleanup-contract-${Math.random().toString(16).slice(2)}`,
  });
  const sessionManager = new SessionManager(context, new MockBrowserController());
  return new ControlApi(sessionManager, context.eventStore);
}

describe("session cleanup contract", () => {
  it("returns deterministic cleanup payload shape", async () => {
    const api = createApi();
    const session = await api.createSession({ browser: "chrome" });
    await api.terminateSession(session.sessionId);

    const result = api.cleanupSessions({ maxAgeDays: 0, dryRun: true });
    expect(result).toHaveProperty("removedSessionIds");
    expect(result).toHaveProperty("removedProfileDirs");
    expect(result).toHaveProperty("dryRun");
    expect(Array.isArray(result.removedSessionIds)).toBe(true);
  });
});
