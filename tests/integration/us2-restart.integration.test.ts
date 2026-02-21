import { describe, expect, it } from "vitest";

import { createDefaultRuntime } from "../../src/cli/runtime.js";
import { runSessionStart } from "../../src/cli/commands/session-start.js";
import { runSessionRestart } from "../../src/cli/commands/session-restart.js";

describe("US2 integration: disconnect -> restart", () => {
  it("recovers after disconnect", async () => {
    const runtime = createDefaultRuntime();
    const started = await runSessionStart(runtime, { browser: "chrome" });

    runtime.sessions.setStatus("disconnected", "heartbeat timeout");
    const restarted = await runSessionRestart(runtime, { sessionId: started.sessionId });

    expect(restarted.status).toBe("ready");
  });
});
