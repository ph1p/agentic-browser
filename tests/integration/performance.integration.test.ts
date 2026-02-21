import { describe, expect, it } from "vitest";

import { createDefaultRuntime } from "../../src/cli/runtime.js";
import { runSessionStart } from "../../src/cli/commands/session-start.js";
import { runCommand } from "../../src/cli/commands/command-run.js";

describe("Performance thresholds", () => {
  it("keeps startup/command operations within target envelope", async () => {
    const runtime = createDefaultRuntime();

    const t0 = Date.now();
    const started = await runSessionStart(runtime, { browser: "chrome" });
    const startupMs = Date.now() - t0;

    const t1 = Date.now();
    await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "perf-1",
      type: "navigate",
      payload: { url: "https://example.com" },
    });
    const commandMs = Date.now() - t1;

    expect(startupMs).toBeLessThanOrEqual(10_000);
    expect(commandMs).toBeLessThanOrEqual(2_000);
  });
});
