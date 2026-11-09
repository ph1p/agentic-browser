import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgenticBrowserCore } from "../../src/cli/runtime.js";
import { redactStepPayload } from "../../src/memory/redact-step-payload.js";
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

  it("drops unknown keys such as expression", () => {
    expect(redactStepPayload({ action: "click", expression: "document.cookie" })).toEqual({
      action: "click",
    });
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
});
