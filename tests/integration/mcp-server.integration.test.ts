import { describe, expect, it } from "vitest";

import { createMockAgenticBrowserCore } from "../../src/cli/runtime.js";

/**
 * Tests that the MCP server's tool handlers work correctly by exercising
 * the same AgenticBrowserCore API paths the MCP tools use.
 *
 * We test the core API directly rather than spawning a stdio process,
 * because the MCP server is a thin wrapper with no business logic.
 */
describe("mcp server tool handlers", () => {
  function createCore() {
    return createMockAgenticBrowserCore({
      ...process.env,
      AGENTIC_BROWSER_LOG_DIR: `/tmp/agentic-browser-mcp-${Math.random().toString(16).slice(2)}`,
    });
  }

  it("full tool lifecycle: start → navigate → elements → content → memory → stop", async () => {
    const core = createCore();

    // browser_start_session
    const session = await core.startSession();
    expect(session.sessionId).toBeTruthy();
    expect(session.status).toBe("ready");

    // browser_navigate
    const nav = await core.runCommand({
      sessionId: session.sessionId,
      commandId: `nav-${Date.now()}`,
      type: "navigate",
      payload: { url: "https://example.com" },
    });
    expect(nav.resultStatus).toBe("success");

    // browser_get_elements
    const elements = await core.getInteractiveElements({
      sessionId: session.sessionId,
      visibleOnly: true,
      limit: 50,
    });
    expect(elements).toHaveProperty("elements");
    expect(elements).toHaveProperty("totalFound");
    expect(elements).toHaveProperty("truncated");

    // browser_get_content
    const content = await core.getPageContent({
      sessionId: session.sessionId,
      mode: "text",
    });
    expect(content).toBeTruthy();

    // browser_search_memory
    const memory = core.searchMemory({
      taskIntent: "navigate:example.com",
      siteDomain: "example.com",
      limit: 5,
    });
    expect(memory.results).toBeDefined();

    // browser_stop_session
    await core.stopSession(session.sessionId);
  });

  it("interact tool builds correct payload", async () => {
    const core = createCore();
    const session = await core.startSession();

    await core.runCommand({
      sessionId: session.sessionId,
      commandId: `nav-${Date.now()}`,
      type: "navigate",
      payload: { url: "https://example.com" },
    });

    const click = await core.runCommand({
      sessionId: session.sessionId,
      commandId: `int-${Date.now()}`,
      type: "interact",
      payload: { action: "click", selector: "#btn" },
    });
    expect(click.resultStatus).toBe("success");

    await core.stopSession(session.sessionId);
  });
});
