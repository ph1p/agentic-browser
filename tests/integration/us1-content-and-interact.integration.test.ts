import { describe, expect, it } from "vitest";

import { createDefaultRuntime } from "../../src/cli/runtime.js";
import { runSessionStart } from "../../src/cli/commands/session-start.js";
import { runCommand } from "../../src/cli/commands/command-run.js";
import { runPageContent } from "../../src/cli/commands/page-content.js";

describe("US1 integration: content + interact", () => {
  it("returns page content and supports interact action", async () => {
    const runtime = createDefaultRuntime();
    const started = await runSessionStart(runtime, { browser: "chrome" });

    await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-1",
      type: "navigate",
      payload: { url: "https://innoq.de" },
    });

    const content = await runPageContent(runtime, {
      sessionId: started.sessionId,
      mode: "text",
    });
    expect(content.mode).toBe("text");
    expect(content.content).toContain("https://innoq.de");

    const interaction = await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-2",
      type: "interact",
      payload: { action: "click", selector: "body" },
    });
    expect(interaction.resultStatus).toBe("success");
  });

  it("supports goBack, goForward, and refresh actions", async () => {
    const runtime = createDefaultRuntime();
    const started = await runSessionStart(runtime, { browser: "chrome" });

    await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "nav-1",
      type: "navigate",
      payload: { url: "https://example.com/page1" },
    });

    await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "nav-2",
      type: "navigate",
      payload: { url: "https://example.com/page2" },
    });

    const back = await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-back",
      type: "interact",
      payload: { action: "goBack" },
    });
    expect(back.resultStatus).toBe("success");
    expect(back.resultMessage).toContain("navigated back");

    const forward = await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-forward",
      type: "interact",
      payload: { action: "goForward" },
    });
    expect(forward.resultStatus).toBe("success");
    expect(forward.resultMessage).toContain("navigated forward");

    const refresh = await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-refresh",
      type: "interact",
      payload: { action: "refresh" },
    });
    expect(refresh.resultStatus).toBe("success");
    expect(refresh.resultMessage).toContain("refreshed");
  });

  it("supports dialog action", async () => {
    const runtime = createDefaultRuntime();
    const started = await runSessionStart(runtime, { browser: "chrome" });

    const accept = await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-dialog-accept",
      type: "interact",
      payload: { action: "dialog" },
    });
    expect(accept.resultStatus).toBe("success");
    expect(accept.resultMessage).toContain("accepted");

    const dismiss = await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-dialog-dismiss",
      type: "interact",
      payload: { action: "dialog", text: "dismiss" },
    });
    expect(dismiss.resultStatus).toBe("success");
    expect(dismiss.resultMessage).toContain("dismissed");
  });
});
