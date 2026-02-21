import { describe, expect, it } from "vitest";

import { createMockAgenticBrowserCore } from "../../src/cli/runtime.js";

describe("programmatic core integration", () => {
  it("supports session lifecycle and memory retrieval without CLI wrappers", async () => {
    const core = createMockAgenticBrowserCore({
      ...process.env,
      AGENTIC_BROWSER_LOG_DIR: `/tmp/agentic-browser-core-${Math.random().toString(16).slice(2)}`,
    });

    const session = await core.startSession();
    const command = await core.runCommand({
      sessionId: session.sessionId,
      commandId: "cmd-core-1",
      type: "navigate",
      payload: { url: "https://example.com" },
    });

    expect(command.resultStatus).toBe("success");

    const search = core.searchMemory({
      taskIntent: "navigate:example.com",
      siteDomain: "example.com",
      limit: 1,
    });

    expect(search.results.length).toBeGreaterThan(0);
    await core.stopSession(session.sessionId);
  });

  it("returns interactive elements from a session", async () => {
    const core = createMockAgenticBrowserCore({
      ...process.env,
      AGENTIC_BROWSER_LOG_DIR: `/tmp/agentic-browser-core-${Math.random().toString(16).slice(2)}`,
    });

    const session = await core.startSession();
    await core.runCommand({
      sessionId: session.sessionId,
      commandId: "cmd-nav-1",
      type: "navigate",
      payload: { url: "https://example.com" },
    });

    const result = await core.getInteractiveElements({
      sessionId: session.sessionId,
      visibleOnly: true,
      limit: 20,
    });

    expect(result).toHaveProperty("elements");
    expect(result).toHaveProperty("totalFound");
    expect(result).toHaveProperty("truncated");
    expect(Array.isArray(result.elements)).toBe(true);

    await core.stopSession(session.sessionId);
  });
});
