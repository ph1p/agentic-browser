import { describe, expect, it } from "vitest";

import { ControlApi } from "../../src/transport/control-api.js";
import { createAppContext } from "../../src/cli/app.js";
import { SessionManager } from "../../src/session/session-manager.js";
import { MockBrowserController } from "../../src/session/browser-controller.js";

function createApi() {
  const context = createAppContext({
    ...process.env,
    AGENTIC_BROWSER_LOG_DIR: `/tmp/agentic-browser-memory-contract-${Math.random().toString(16).slice(2)}`,
  });
  const sessionManager = new SessionManager(context, new MockBrowserController());
  return new ControlApi(sessionManager, context.eventStore);
}

describe("memory search contract", () => {
  it("returns machine-readable ranked results", async () => {
    const api = createApi();
    const session = await api.createSession({ browser: "chrome" });

    await api.executeCommand(session.sessionId, {
      commandId: "cmd-1",
      type: "navigate",
      payload: { url: "https://example.com" },
    });

    const result = api.searchMemory({
      taskIntent: "navigate:example.com",
      siteDomain: "example.com",
      limit: 10,
    });

    expect(Array.isArray(result.results)).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results[0]).toHaveProperty("insightId");
    expect(result.results[0]).toHaveProperty("score");
  });
});
