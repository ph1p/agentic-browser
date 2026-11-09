import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgenticBrowserCore } from "../../src/cli/runtime.js";
import { MemoryService } from "../../src/memory/memory-service.js";
import { redactStepPayload, redactUrlsInText } from "../../src/memory/redact-step-payload.js";
import { TaskInsightStore } from "../../src/memory/task-insight-store.js";
import { MockBrowserController } from "../../src/session/browser-controller.js";

const tempDirs: string[] = [];

function makeDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-redact-"));
  tempDirs.push(dir);
  return dir;
}

function readMemoryFiles(dir: string): string {
  const memoryDir = path.join(dir, "memory");
  return fs
    .readdirSync(memoryDir)
    .map((name) => fs.readFileSync(path.join(memoryDir, name), "utf8"))
    .join("\n");
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("redactStepPayload", () => {
  it("drops typed text and flags redaction", () => {
    expect(redactStepPayload({ action: "type", selector: "#pw", text: "hunter2" })).toEqual({
      action: "type",
      selector: "#pw",
      redacted: true,
    });
  });

  it("flags redaction for select values", () => {
    expect(redactStepPayload({ action: "select", selector: "#c", value: "secret" })).toEqual({
      action: "select",
      selector: "#c",
      redacted: true,
    });
  });

  it("strips query string and fragment from url", () => {
    expect(redactStepPayload({ url: "https://example.com/a/b?token=abc#x" })).toEqual({
      url: "https://example.com/a/b",
    });
  });

  it("drops unparseable url", () => {
    expect(redactStepPayload({ url: "not a url" })).toEqual({});
  });

  it("is idempotent", () => {
    const payload = {
      action: "type",
      selector: "#a",
      text: "hunter2",
      url: "https://example.com/p?token=abc#x",
    };
    const once = redactStepPayload(payload);
    expect(once.redacted).toBe(true);
    expect(redactStepPayload(once)).toEqual(once);
  });

  it("drops unknown keys such as expression", () => {
    expect(redactStepPayload({ action: "click", expression: "document.cookie" })).toEqual({
      action: "click",
    });
  });
});

describe("redactUrlsInText", () => {
  it("strips query string and fragment from embedded urls", () => {
    expect(redactUrlsInText("Navigated to https://x.com/cb?code=SECRET#frag")).toBe(
      "Navigated to https://x.com/cb",
    );
  });
});

describe("memory persistence", () => {
  it("never writes typed text to memory files", async () => {
    const dir = makeDir();
    const core = createAgenticBrowserCore({
      env: { ...process.env, AGENTIC_BROWSER_DIR: dir },
      browserController: new MockBrowserController(),
    });
    const session = await core.startSession();
    await core.runCommand({
      sessionId: session.sessionId,
      type: "navigate",
      payload: { url: "https://example.com/login?token=URLSECRET" },
    });
    await core.runCommand({
      sessionId: session.sessionId,
      type: "interact",
      payload: { action: "type", selector: "#pw", text: "SECRET-123" },
    });
    core.context.memoryService.flushSync();

    const contents = readMemoryFiles(dir);
    expect(contents).toContain("#pw");
    expect(contents).not.toContain("SECRET-123");
    expect(contents).toContain('"url": "https://example.com/login"');
  });

  it("sanitizes already-persisted insights on load", () => {
    const dir = makeDir();
    const memoryDir = path.join(dir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const now = new Date().toISOString();
    const insight = {
      insightId: "ins-1",
      taskIntent: "interact:type:example.com",
      siteDomain: "example.com",
      sitePathPattern: "/",
      actionRecipe: [
        {
          type: "interact",
          summary: "interact:type",
          selector: "#pw",
          payload: { action: "type", selector: "#pw", text: "OLD-SECRET" },
        },
      ],
      expectedOutcome: "ok",
      confidence: 0.5,
      successCount: 1,
      failureCount: 0,
      useCount: 0,
      freshness: "fresh",
      staleStrikeCount: 0,
      selectorAliases: [],
      evidence: [],
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(
      path.join(memoryDir, "insights.json"),
      JSON.stringify({ insights: [insight] }),
      "utf8",
    );

    const store = new TaskInsightStore(dir);
    const loaded = store.list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]?.actionRecipe[0]?.payload).toEqual({
      action: "type",
      selector: "#pw",
      redacted: true,
    });

    store.flushSync();
    const contents = fs.readFileSync(path.join(memoryDir, "insights.json"), "utf8");
    expect(contents).not.toContain("OLD-SECRET");
    expect(contents).toContain("#pw");
  });

  it("never persists url query strings or fragments from a navigate", async () => {
    const dir = makeDir();
    const core = createAgenticBrowserCore({
      env: { ...process.env, AGENTIC_BROWSER_DIR: dir },
      browserController: new MockBrowserController(),
    });
    const session = await core.startSession();
    await core.runCommand({
      sessionId: session.sessionId,
      type: "navigate",
      payload: { url: "https://example.com/cb?token=SECRET#frag" },
    });
    core.context.memoryService.flushSync();

    const contents = fs.readFileSync(path.join(dir, "memory", "insights.json"), "utf8");
    expect(contents).toContain("https://example.com/cb");
    expect(contents).not.toContain("SECRET");
    expect(contents).not.toContain("#frag");
  });

  it("strips urls from failure evidence reasons", () => {
    const dir = makeDir();
    const service = new MemoryService(dir);
    const input = {
      commandId: "cmd-1",
      taskIntent: "interact:click:example.com",
      siteDomain: "example.com",
      sitePathPattern: "/",
      expectedOutcome: "clicked",
      step: { type: "interact" as const, summary: "interact:click", payload: {} },
      selector: "#go",
      url: "https://example.com/page?session=SECRET",
    };
    service.recordSuccess(input);
    const failed = service.recordFailure(
      { ...input, commandId: "cmd-2" },
      "Navigation to https://example.com/next?token=SECRET#frag failed",
    );

    expect(failed).toBeDefined();
    const failure = failed?.evidence.find((ev) => ev.result === "failure");
    expect(failure?.reason).toBe("Navigation to https://example.com/next failed");
    for (const ev of failed?.evidence ?? []) {
      expect(ev.url).toBe("https://example.com/page");
      expect(ev.reason ?? "").not.toContain("SECRET");
    }
  });

  it("strips urls from already-persisted insights on load", () => {
    const dir = makeDir();
    const memoryDir = path.join(dir, "memory");
    fs.mkdirSync(memoryDir, { recursive: true });
    const now = new Date().toISOString();
    const insight = {
      insightId: "ins-2",
      taskIntent: "navigate:example.com",
      siteDomain: "example.com",
      sitePathPattern: "/",
      actionRecipe: [{ type: "navigate", summary: "navigate", payload: {} }],
      expectedOutcome: "Navigated to https://example.com/cb?token=SECRET",
      confidence: 0.5,
      successCount: 1,
      failureCount: 1,
      useCount: 0,
      freshness: "fresh",
      staleStrikeCount: 0,
      selectorAliases: [],
      evidence: [
        {
          evidenceId: "ev-1",
          commandId: "cmd-1",
          result: "failure",
          reason: "Timed out loading https://example.com/cb?token=SECRET",
          url: "https://example.com/cb?token=SECRET#frag",
          recordedAt: now,
        },
      ],
      lastVerifiedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    fs.writeFileSync(
      path.join(memoryDir, "insights.json"),
      JSON.stringify({ insights: [insight] }),
      "utf8",
    );

    const store = new TaskInsightStore(dir);
    const loaded = store.list();
    expect(loaded[0]?.expectedOutcome).toBe("Navigated to https://example.com/cb");
    expect(loaded[0]?.evidence[0]?.url).toBe("https://example.com/cb");
    expect(loaded[0]?.evidence[0]?.reason).toBe("Timed out loading https://example.com/cb");

    store.flushSync();
    const contents = fs.readFileSync(path.join(memoryDir, "insights.json"), "utf8");
    expect(contents).not.toContain("SECRET");
    expect(contents).not.toContain("#frag");
  });
});
