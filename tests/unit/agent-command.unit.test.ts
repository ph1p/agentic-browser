import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAgenticBrowserCore, type AgenticBrowserCore } from "../../src/cli/runtime.js";
import {
  agentElements,
  agentEval,
  agentInteract,
  agentNavigate,
  agentScreenshot,
  agentStart,
  agentStatus,
  agentTabClose,
  agentTabNew,
  agentTabs,
  agentTabSwitch,
  agentTerminate,
  agentWait,
  matchesUrlPattern,
} from "../../src/cli/commands/agent.js";
import {
  MockBrowserController,
  type DismissCookieBannerResult,
  type InteractiveElementsOptions,
  type InteractiveElementsResult,
  type InteractPayload,
} from "../../src/session/browser-controller.js";

const tempDirs: string[] = [];
const cores: AgenticBrowserCore[] = [];

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

class RecordingBrowserController extends CookieMockBrowserController {
  payloads: InteractPayload[] = [];
  elementOptions: InteractiveElementsOptions[] = [];

  override async interact(cdpUrl: string, payload: InteractPayload): Promise<string> {
    this.payloads.push(payload);
    if (payload.action === "evaluate") return JSON.stringify({ answer: 42 });
    return super.interact(cdpUrl, payload);
  }

  override async getInteractiveElements(
    targetWsUrl: string,
    options: InteractiveElementsOptions,
  ): Promise<InteractiveElementsResult> {
    this.elementOptions.push(options);
    return super.getInteractiveElements(targetWsUrl, options);
  }
}

function makeRecordingRuntime() {
  const browserController = new RecordingBrowserController();
  return { runtime: makeFailingRuntime(browserController), browser: browserController };
}

function makeFailingRuntime(browserController: MockBrowserController) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-agent-"));
  tempDirs.push(dir);
  const core = createAgenticBrowserCore({
    env: { ...process.env, AGENTIC_BROWSER_DIR: dir },
    browserController,
  });
  cores.push(core);
  return core;
}

function makeRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-agent-"));
  tempDirs.push(dir);
  const core = createAgenticBrowserCore({
    env: {
      ...process.env,
      AGENTIC_BROWSER_DIR: dir,
    },
    browserController: new CookieMockBrowserController(),
  });
  cores.push(core);
  return core;
}

afterEach(async () => {
  await Promise.all(cores.splice(0).map((core) => core.dispose()));
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

  it("agent screenshot writes the decoded image to --out", async () => {
    const runtime = makeRuntime();
    await agentStart(runtime);
    const out = path.join(tempDirs[0]!, "nested", "shot.png");

    const result = await agentScreenshot(runtime, { out, format: "png" });

    expect(result).toMatchObject({
      ok: true,
      action: "screenshot",
      path: out,
      mimeType: "image/png",
    });
    expect(fs.readFileSync(out).toString()).toBe("mock");
    expect(result.bytes).toBe(4);
  });

  it("agent screenshot defaults to a private file under the data dir", async () => {
    const runtime = makeRuntime();
    await agentStart(runtime);

    const result = await agentScreenshot(runtime, { format: "jpeg" });

    expect(result.path.startsWith(path.join(tempDirs[0]!, "screenshots"))).toBe(true);
    expect(result.path.endsWith(".jpg")).toBe(true);
    expect(fs.statSync(result.path).mode & 0o777).toBe(0o600);
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

  it("agent status and navigate report the current url", async () => {
    const runtime = makeRuntime();
    await agentStart(runtime);
    const nav = await agentNavigate(runtime, { url: "https://example.com/a" });
    expect(nav.url).toBe("https://example.com/a");
    const status = await agentStatus(runtime);
    expect(status).toMatchObject({ ok: true, url: "https://example.com/a" });
  });

  it("agent eval parses the JSON value and forwards the frame", async () => {
    const { runtime, browser } = makeRecordingRuntime();
    await agentStart(runtime);
    const result = await agentEval(runtime, { expression: "({answer: 42})", frame: "#f" });
    expect(result).toMatchObject({ ok: true, action: "eval", result: { answer: 42 } });
    expect(browser.payloads.at(-1)).toMatchObject({
      action: "evaluate",
      text: "({answer: 42})",
      frame: "#f",
    });
  });

  it("agent elements forwards href, text and frame filters", async () => {
    const { runtime, browser } = makeRecordingRuntime();
    await agentStart(runtime);
    await agentElements(runtime, { href: "/news", text: "gta", frame: "iframe#x" });
    expect(browser.elementOptions.at(-1)).toMatchObject({
      href: "/news",
      text: "gta",
      frame: "iframe#x",
    });
  });

  it("matchesUrlPattern supports substring, glob and regex", () => {
    expect(matchesUrlPattern("https://a.com/x/y", "/x/")).toBe(true);
    expect(matchesUrlPattern("https://a.com/x/y", "https://a.com/*")).toBe(true);
    expect(matchesUrlPattern("https://a.com/x/y", "https://b.com/*")).toBe(false);
    expect(matchesUrlPattern("https://a.com/x/y", "/a\\.com\\/x/")).toBe(true);
    expect(matchesUrlPattern("https://a.com/x?q=1", "x?q")).toBe(true);
  });

  it("agent wait --url resolves on match and times out with the current url", async () => {
    const runtime = makeRuntime();
    await agentStart(runtime);
    await agentNavigate(runtime, { url: "https://example.com/done" });
    const ok = await agentWait(runtime, { url: "/done", load: true, timeoutMs: 1000 });
    expect(ok).toMatchObject({ ok: true, action: "wait", url: "https://example.com/done" });
    await expect(agentWait(runtime, { url: "/never", timeoutMs: 300 })).rejects.toThrow(
      /wait timeout after 300ms.*example\.com\/done/,
    );
    await expect(agentWait(runtime, {})).rejects.toThrow("Nothing to wait for");
  });

  it("agent wait --text waits via a text= locator", async () => {
    const { runtime, browser } = makeRecordingRuntime();
    await agentStart(runtime);
    await agentWait(runtime, { text: "Accept all", frame: "#cmp", timeoutMs: 1000 });
    expect(browser.payloads.at(-1)).toMatchObject({
      action: "waitFor",
      selector: "text=Accept all",
      frame: "#cmp",
    });
  });

  it("agent tabs: new, list, switch, close", async () => {
    const runtime = makeRuntime();
    await agentStart(runtime);
    await agentNavigate(runtime, { url: "https://example.com/one" });

    const created = await agentTabNew(runtime, { url: "https://example.com/two" });
    expect(created).toMatchObject({ action: "tab-new", url: "https://example.com/two" });

    const listed = await agentTabs(runtime);
    expect(listed.tabs).toHaveLength(2);
    expect(listed.tabs.find((tab) => tab.active)?.id).toBe(created.id);
    const first = listed.tabs.find((tab) => !tab.active)!;

    const switched = await agentTabSwitch(runtime, { id: first.id });
    expect(switched.url).toBe("https://example.com/one");
    expect((await agentStatus(runtime)).url).toBe("https://example.com/one");

    const closed = await agentTabClose(runtime, { id: first.id });
    expect(closed.active.id).toBe(created.id);
    expect((await agentStatus(runtime)).url).toBe("https://example.com/two");
    await expect(agentTabClose(runtime, { id: created.id })).rejects.toThrow("last tab");
  });
});
