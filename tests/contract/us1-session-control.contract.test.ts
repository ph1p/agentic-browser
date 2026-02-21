import { describe, expect, it } from "vitest";

import { ControlApi } from "../../src/transport/control-api.js";
import { createAppContext } from "../../src/cli/app.js";
import { SessionManager } from "../../src/session/session-manager.js";
import { MockBrowserController } from "../../src/session/browser-controller.js";

function createApi() {
  const context = createAppContext({
    ...process.env,
    AGENTIC_BROWSER_LOG_DIR: `/tmp/agentic-browser-contract-${Math.random().toString(16).slice(2)}`,
  });
  const sessionManager = new SessionManager(context, new MockBrowserController());
  return new ControlApi(sessionManager, context.eventStore);
}

describe("US1 contract: session control endpoints", () => {
  it("creates and returns session status", async () => {
    const api = createApi();
    const created = await api.createSession({ browser: "chrome" });
    expect(created.status).toBe("ready");

    const fetched = api.getSession(created.sessionId);
    expect(fetched.sessionId).toBe(created.sessionId);
  });

  it("executes command and terminates session", async () => {
    const api = createApi();
    const created = await api.createSession({ browser: "chrome" });

    const result = await api.executeCommand(created.sessionId, {
      commandId: "cmd-1",
      type: "navigate",
      payload: { url: "https://example.com" },
    });

    expect(result.resultStatus).toBe("success");
    await api.terminateSession(created.sessionId);
    expect(api.getSession(created.sessionId).status).toBe("terminated");
  });
});
