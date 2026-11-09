import { describe, expect, it } from "vitest";

import { createMockAgenticBrowserCore } from "../../src/cli/runtime.js";
import { assertNavigableUrl } from "../../src/session/url-policy.js";

const strict = { allowFileUrls: false };

describe("assertNavigableUrl", () => {
  it("allows http, https and about:blank", () => {
    for (const url of ["https://example.com", "http://localhost:3000", "about:blank"]) {
      expect(() => assertNavigableUrl(url, strict)).not.toThrow();
    }
  });

  it("rejects other schemes", () => {
    for (const url of [
      "file:///etc/passwd",
      "chrome://settings",
      "javascript:alert(1)",
      "view-source:https://x.com",
      "data:text/html,hi",
    ]) {
      expect(() => assertNavigableUrl(url, strict)).toThrow(/not allowed/);
    }
  });

  it("rejects unparseable URLs", () => {
    expect(() => assertNavigableUrl("example.com", strict)).toThrow(/Invalid URL/);
  });

  it("allows file: only with opt-in, and hints at the env var", () => {
    expect(() => assertNavigableUrl("file:///tmp/x.html", { allowFileUrls: true })).not.toThrow();
    expect(() => assertNavigableUrl("file:///tmp/x.html", strict)).toThrow(
      /AGENTIC_BROWSER_ALLOW_FILE_URLS/,
    );
  });
});

describe("navigate command policy", () => {
  it("fails a file: navigate through the core by default", async () => {
    const core = createMockAgenticBrowserCore({
      ...process.env,
      AGENTIC_BROWSER_ALLOW_FILE_URLS: "",
      AGENTIC_BROWSER_DIR: `/tmp/agentic-browser-url-policy-${Math.random().toString(16).slice(2)}`,
    });
    const session = await core.startSession();
    const result = await core.runCommand({
      sessionId: session.sessionId,
      type: "navigate",
      payload: { url: "file:///etc/passwd" },
    });
    expect(result.resultStatus).toBe("failed");
    expect(result.resultMessage).toMatch(/not allowed/);
  });
});
