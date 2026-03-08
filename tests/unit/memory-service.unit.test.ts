import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MemoryService } from "../../src/memory/memory-service.js";

const tempDirs: string[] = [];

function createService(): MemoryService {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-memory-"));
  tempDirs.push(dir);
  return new MemoryService(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("MemoryService exact match selection", () => {
  it("prefers insights with the same path pattern and selector", () => {
    const service = createService();

    const loginInsight = service.recordSuccess({
      commandId: "cmd-login-success",
      taskIntent: "interact:type:example.com",
      siteDomain: "example.com",
      sitePathPattern: "/login/*",
      expectedOutcome: "login typed",
      step: { type: "interact", summary: "type email", selector: "#email", payload: {} },
      selector: "#email",
      url: "https://example.com/login",
    });

    service.recordSuccess({
      commandId: "cmd-account-success",
      taskIntent: "interact:type:example.com",
      siteDomain: "example.com",
      sitePathPattern: "/account/*",
      expectedOutcome: "account typed",
      step: { type: "interact", summary: "type email", selector: "#search", payload: {} },
      selector: "#search",
      url: "https://example.com/account",
    });

    const failed = service.recordFailure(
      {
        commandId: "cmd-login-failure",
        taskIntent: "interact:type:example.com",
        siteDomain: "example.com",
        sitePathPattern: "/login/*",
        expectedOutcome: "login typed",
        step: { type: "interact", summary: "type email", selector: "#email", payload: {} },
        selector: "#email",
        url: "https://example.com/login",
      },
      "Selector not found",
    );

    expect(failed?.insightId).toBe(loginInsight.insightId);
    expect(failed?.failureCount).toBe(1);
  });
});
