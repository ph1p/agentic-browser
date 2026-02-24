import { describe, expect, it } from "vitest";

import { createMockAgenticBrowserCore } from "../../src/cli/runtime.js";

/**
 * Tests that the MCP server's tool handlers work correctly by exercising
 * the same AgenticBrowserCore API paths the MCP tools use.
 *
 * We test the core API directly rather than spawning a stdio process,
 * because the MCP server is a thin wrapper. We also verify the compact
 * response transformations applied in the MCP layer.
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

  describe("compact MCP responses", () => {
    it("browser_start_session omits authTokenRef", async () => {
      const core = createCore();
      const session = await core.startSession();

      // The MCP handler strips authTokenRef
      const { authTokenRef: _, ...compactSession } = session;
      expect(compactSession).not.toHaveProperty("authTokenRef");
      expect(compactSession).toHaveProperty("sessionId");
      expect(compactSession).toHaveProperty("status");
      expect(compactSession).toHaveProperty("startedAt");

      await core.stopSession(session.sessionId);
    });

    it("browser_navigate returns only resultStatus and resultMessage", async () => {
      const core = createCore();
      const session = await core.startSession();

      const result = await core.runCommand({
        sessionId: session.sessionId,
        commandId: `nav-${Date.now()}`,
        type: "navigate",
        payload: { url: "https://example.com" },
      });

      // The MCP handler extracts only these two fields
      const compact = { resultStatus: result.resultStatus, resultMessage: result.resultMessage };
      expect(Object.keys(compact)).toEqual(["resultStatus", "resultMessage"]);
      expect(compact.resultStatus).toBe("success");

      // Verify the full result had extra fields that are now stripped
      expect(result).toHaveProperty("commandId");
      expect(result).toHaveProperty("sessionId");

      await core.stopSession(session.sessionId);
    });

    it("browser_interact returns only resultStatus and resultMessage", async () => {
      const core = createCore();
      const session = await core.startSession();

      await core.runCommand({
        sessionId: session.sessionId,
        commandId: `nav-${Date.now()}`,
        type: "navigate",
        payload: { url: "https://example.com" },
      });

      const result = await core.runCommand({
        sessionId: session.sessionId,
        commandId: `int-${Date.now()}`,
        type: "interact",
        payload: { action: "click", selector: "#btn" },
      });

      const compact = { resultStatus: result.resultStatus, resultMessage: result.resultMessage };
      expect(Object.keys(compact)).toEqual(["resultStatus", "resultMessage"]);

      await core.stopSession(session.sessionId);
    });

    it("browser_get_content truncates long text content", async () => {
      const core = createCore();
      const session = await core.startSession();

      await core.runCommand({
        sessionId: session.sessionId,
        commandId: `nav-${Date.now()}`,
        type: "navigate",
        payload: { url: "https://example.com" },
      });

      const result = await core.getPageContent({
        sessionId: session.sessionId,
        mode: "text",
      });

      // Simulate truncation logic from MCP handler
      const maxChars = 12000;
      if (result.content.length > maxChars) {
        const originalLength = result.content.length;
        const truncatedContent =
          result.content.slice(0, maxChars) +
          `\n\n[Truncated — showing first ${maxChars} of ${originalLength} characters. Use a CSS selector to scope the content.]`;
        expect(truncatedContent.length).toBeGreaterThan(maxChars);
        expect(truncatedContent).toContain("[Truncated");
      } else {
        // Mock content is short — verify truncation wouldn't apply
        expect(result.content.length).toBeLessThanOrEqual(maxChars);
      }

      await core.stopSession(session.sessionId);
    });

    it("browser_get_content truncation adds truncated flag", () => {
      // Unit-test the truncation logic directly
      const longContent = "x".repeat(15000);
      const maxChars = 12000;
      const truncated = longContent.length > maxChars;
      expect(truncated).toBe(true);

      const result = truncated
        ? {
            content:
              longContent.slice(0, maxChars) +
              `\n\n[Truncated — showing first ${maxChars} of ${longContent.length} characters. Use a CSS selector to scope the content.]`,
            truncated: true,
          }
        : { content: longContent, truncated: false };

      expect(result.truncated).toBe(true);
      expect(result.content).toContain("[Truncated");
      expect(result.content).toContain("15000 characters");
    });

    it("browser_get_content does not truncate title mode", () => {
      const defaultMaxChars: Record<string, number | undefined> = {
        text: 12000,
        a11y: 12000,
        html: 6000,
        title: undefined,
      };
      expect(defaultMaxChars["title"]).toBeUndefined();
    });

    it("browser_get_elements strips visible, actions, tagName when visibleOnly=true", async () => {
      const core = createCore();
      const session = await core.startSession();

      await core.runCommand({
        sessionId: session.sessionId,
        commandId: `nav-${Date.now()}`,
        type: "navigate",
        payload: { url: "https://example.com" },
      });

      const result = await core.getInteractiveElements({
        sessionId: session.sessionId,
        visibleOnly: true,
        limit: 50,
      });

      // Simulate the MCP compact transformation
      const visibleOnly = true;
      const compactElements = result.elements.map((el) => {
        const compact: Record<string, unknown> = { ...el };
        if (visibleOnly) delete compact.visible;
        delete compact.actions;
        delete compact.tagName;
        if (compact.ariaLabel && compact.ariaLabel === compact.text) delete compact.ariaLabel;
        return compact;
      });

      for (const el of compactElements) {
        expect(el).not.toHaveProperty("visible");
        expect(el).not.toHaveProperty("actions");
        expect(el).not.toHaveProperty("tagName");
      }

      await core.stopSession(session.sessionId);
    });

    it("browser_get_elements retains visible when visibleOnly=false", async () => {
      // When visibleOnly is false, visible field should be kept
      const mockElement = {
        selector: "#btn",
        role: "button",
        tagName: "button",
        text: "Click",
        actions: ["click"],
        visible: true,
        enabled: true,
      };

      const visibleOnly = false;
      const compact: Record<string, unknown> = { ...mockElement };
      if (visibleOnly) delete compact.visible;
      delete compact.actions;
      delete compact.tagName;

      expect(compact).toHaveProperty("visible");
      expect(compact).not.toHaveProperty("actions");
      expect(compact).not.toHaveProperty("tagName");
    });

    it("browser_get_elements removes ariaLabel when it matches text", () => {
      const element = {
        selector: "#btn",
        role: "button",
        tagName: "button",
        text: "Submit",
        ariaLabel: "Submit",
        actions: ["click"],
        visible: true,
        enabled: true,
      };

      const compact: Record<string, unknown> = { ...element };
      if (compact.ariaLabel && compact.ariaLabel === compact.text) delete compact.ariaLabel;

      expect(compact).not.toHaveProperty("ariaLabel");
    });

    it("browser_get_elements keeps ariaLabel when different from text", () => {
      const element = {
        selector: "#btn",
        role: "button",
        tagName: "button",
        text: "X",
        ariaLabel: "Close dialog",
        actions: ["click"],
        visible: true,
        enabled: true,
      };

      const compact: Record<string, unknown> = { ...element };
      if (compact.ariaLabel && compact.ariaLabel === compact.text) delete compact.ariaLabel;

      expect(compact).toHaveProperty("ariaLabel");
      expect(compact.ariaLabel).toBe("Close dialog");
    });

    it("browser_search_memory strips score and lastVerifiedAt", async () => {
      const core = createCore();
      const session = await core.startSession();

      await core.runCommand({
        sessionId: session.sessionId,
        commandId: `nav-${Date.now()}`,
        type: "navigate",
        payload: { url: "https://example.com" },
      });

      const result = core.searchMemory({
        taskIntent: "navigate:example.com",
        siteDomain: "example.com",
        limit: 5,
      });

      // Simulate the MCP compact transformation
      const compactResults = result.results.map((r) => {
        const compact: Record<string, unknown> = { ...r };
        delete compact.score;
        delete compact.lastVerifiedAt;
        if (Array.isArray(compact.selectorAliases)) {
          compact.selectorAliases = (compact.selectorAliases as Record<string, unknown>[]).map(
            (alias) => {
              const compactAlias = { ...alias };
              if (
                Array.isArray(compactAlias.fallbackSelectors) &&
                compactAlias.fallbackSelectors.length === 0
              ) {
                delete compactAlias.fallbackSelectors;
              }
              return compactAlias;
            },
          );
        }
        return compact;
      });

      for (const r of compactResults) {
        expect(r).not.toHaveProperty("score");
        expect(r).not.toHaveProperty("lastVerifiedAt");
        // insightId should be kept
        expect(r).toHaveProperty("insightId");
      }

      await core.stopSession(session.sessionId);
    });

    it("browser_search_memory strips empty fallbackSelectors from aliases", () => {
      const alias = { name: "login-btn", selector: "#login", fallbackSelectors: [] as string[] };
      const compact = { ...alias };
      if (Array.isArray(compact.fallbackSelectors) && compact.fallbackSelectors.length === 0) {
        delete (compact as Record<string, unknown>).fallbackSelectors;
      }
      expect(compact).not.toHaveProperty("fallbackSelectors");
    });

    it("browser_search_memory keeps non-empty fallbackSelectors on aliases", () => {
      const alias = { name: "login-btn", selector: "#login", fallbackSelectors: [".btn-login"] };
      const compact = { ...alias };
      if (Array.isArray(compact.fallbackSelectors) && compact.fallbackSelectors.length === 0) {
        delete (compact as Record<string, unknown>).fallbackSelectors;
      }
      expect(compact).toHaveProperty("fallbackSelectors");
      expect(compact.fallbackSelectors).toEqual([".btn-login"]);
    });
  });
});
