import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAgenticBrowserCore } from "../../src/cli/runtime.js";
import { agentNavigate, agentStart } from "../../src/cli/commands/agent.js";
import {
  MockBrowserController,
  type DismissCookieBannerResult,
} from "../../src/session/browser-controller.js";

const tempDirs: string[] = [];

class CookieMockBrowserController extends MockBrowserController {
  override async dismissCookieBanner(): Promise<DismissCookieBannerResult> {
    return { dismissed: true, method: "selector", detail: "#accept-cookies" };
  }
}

function makeRuntime() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentic-browser-agent-"));
  tempDirs.push(dir);
  return createAgenticBrowserCore({
    env: {
      ...process.env,
      AGENTIC_BROWSER_LOG_DIR: dir,
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
});
