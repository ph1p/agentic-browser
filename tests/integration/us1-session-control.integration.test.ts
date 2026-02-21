import { describe, expect, it } from "vitest";

import { runSessionStart } from "../../src/cli/commands/session-start.js";
import { runSessionStatus } from "../../src/cli/commands/session-status.js";
import { runCommand } from "../../src/cli/commands/command-run.js";
import { runSessionStop } from "../../src/cli/commands/session-stop.js";
import { createDefaultRuntime } from "../../src/cli/runtime.js";

describe("US1 integration: start -> navigate -> terminate", () => {
  it("runs full journey with deterministic outputs", async () => {
    const runtime = createDefaultRuntime();

    const started = await runSessionStart(runtime, { browser: "chrome" });
    expect(started.resultStatus).toBe("success");

    const status = await runSessionStatus(runtime, { sessionId: started.sessionId });
    expect(status.status).toBe("ready");

    const command = await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-1",
      type: "navigate",
      payload: { url: "https://example.com" },
    });
    expect(command.resultStatus).toBe("success");

    const stop = await runSessionStop(runtime, { sessionId: started.sessionId });
    expect(stop.terminated).toBe(true);
  });
});
