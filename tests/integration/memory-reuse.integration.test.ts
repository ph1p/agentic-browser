import { describe, expect, it } from "vitest";

import { createDefaultRuntime } from "../../src/cli/runtime.js";
import { runSessionStart } from "../../src/cli/commands/session-start.js";
import { runCommand } from "../../src/cli/commands/command-run.js";
import { runMemorySearch } from "../../src/cli/commands/memory-search.js";
import { runMemoryInspect } from "../../src/cli/commands/memory-inspect.js";

describe("memory reuse integration", () => {
  it("stores and reuses task insight metadata for repeated runs", async () => {
    const runtime = createDefaultRuntime();
    const started = await runSessionStart(runtime, { browser: "chrome" });

    await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-1",
      type: "navigate",
      payload: { url: "https://example.com" },
    });

    await runCommand(runtime, {
      sessionId: started.sessionId,
      commandId: "cmd-2",
      type: "navigate",
      payload: { url: "https://example.com" },
    });

    const search = await runMemorySearch(runtime, {
      taskIntent: "navigate:example.com",
      siteDomain: "example.com",
      limit: 5,
    });

    expect(search.results.length).toBeGreaterThan(0);
    const inspect = await runMemoryInspect(runtime, { insightId: search.results[0].insightId });
    expect(inspect.useCount).toBeGreaterThanOrEqual(2);
    expect(inspect.freshness).toBe("fresh");
  });
});
