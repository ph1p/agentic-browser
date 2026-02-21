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
});
