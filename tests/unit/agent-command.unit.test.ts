import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgenticBrowserCore } from "../../src/cli/runtime.js";
import {
  agentInteract,
  agentNavigate,
  agentStart,
  agentTerminate,
} from "../../src/cli/commands/agent.js";
import {
  MockBrowserController,
  type DismissCookieBannerResult,
  type InteractPayload,
} from "../../src/session/browser-controller.js";

const tempDirs: string[] = [];

class CookieMockBrowserController extends MockBrowserController {
  override async dismissCookieBanner(): Promise<DismissCookieBannerResult> {
    return { dismissed: true, method: "selector", detail: "#accept-cookies" };
  }
}

class FailingBrowserController extends MockBrowserController {
  interactErrors: Error[] = [];
  terminateError: Error | null = null;

  override async interact(cdpUrl: string, payload: InteractPayload): Promise<string> {
    const error = this.interactErrors.shift();
    if (error) throw error;
    return super.interact(cdpUrl, payload);
  }

  override terminate(pid: number): void {
    if (this.terminateError) throw this.terminateError;
    super.terminate(pid);
  }
}

function makeFailingRuntime(browserController: FailingBrowserController) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-agent-"));
  tempDirs.push(dir);
  return createAgenticBrowserCore({
    env: { ...process.env, AGENTIC_BROWSER_DIR: dir },
    browserController,
  });
}

function makeRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-agent-"));
  tempDirs.push(dir);
  return createAgenticBrowserCore({
    env: {
      ...process.env,
      AGENTIC_BROWSER_DIR: dir,
    },
    browserController: new CookieMockBrowserController(),
  });
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("agent commands", () => {
  it("agent navigate reports the typed action and cookie dismissal result", async () => {
    const runtime = makeRuntime();
    await agentStart(runtime);

    const result = await agentNavigate(runtime, { url: "https://example.com" });

    expect(result.action).toBe("navigate");
    expect(result.resultStatus).toBe("success");
    expect(result.cookieBanner).toEqual({
      dismissed: true,
      method: "selector",
      detail: "#accept-cookies",
    });
  });

  it("does not restart the browser on a non-connection interact failure", async () => {
    const browser = new FailingBrowserController();
    browser.interactErrors = [new Error("Element not found: #x")];
    const runtime = makeFailingRuntime(browser);
    await agentStart(runtime);
    const restart = vi.spyOn(runtime.api, "restartSession");

    await expect(agentInteract(runtime, { action: "click", selector: "#x" })).rejects.toThrow(
      "Element not found: #x",
    );
    expect(restart).toHaveBeenCalledTimes(0);
  });

  it("restarts once and retries on a connection error", async () => {
    const browser = new FailingBrowserController();
    browser.interactErrors = [new Error("CDP connection closed")];
    const runtime = makeFailingRuntime(browser);
    await agentStart(runtime);
    const restart = vi.spyOn(runtime.api, "restartSession");

    const result = await agentInteract(runtime, { action: "click", selector: "#x" });

    expect(result.resultStatus).toBe("success");
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("does not restart when terminate fails with a non-connection error", async () => {
    const browser = new FailingBrowserController();
    browser.terminateError = new Error("kill failed: EPERM");
    const runtime = makeFailingRuntime(browser);
    await agentStart(runtime);
    const restart = vi.spyOn(runtime.api, "restartSession");

    await expect(agentTerminate(runtime)).rejects.toThrow("kill failed: EPERM");
    expect(restart).toHaveBeenCalledTimes(0);
  });
});
