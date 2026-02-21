import { describe, expect, it } from "vitest";

import { createDefaultRuntime } from "../../src/cli/runtime.js";
import { runSessionCleanup } from "../../src/cli/commands/session-cleanup.js";
import { runSessionStart } from "../../src/cli/commands/session-start.js";
import { runSessionStatus } from "../../src/cli/commands/session-status.js";
import { runSessionStop } from "../../src/cli/commands/session-stop.js";

describe("session cleanup integration", () => {
  it("cleans terminated sessions and keeps active session", async () => {
    const runtime = createDefaultRuntime();

    const oldSession = await runSessionStart(runtime, { browser: "chrome" });
    await runSessionStop(runtime, { sessionId: oldSession.sessionId });

    const activeSession = await runSessionStart(runtime, { browser: "chrome" });

    const preview = await runSessionCleanup(runtime, { maxAgeDays: 0, dryRun: true });
    expect(preview.removedSessionIds).toContain(oldSession.sessionId);

    const cleaned = await runSessionCleanup(runtime, { maxAgeDays: 0 });
    expect(cleaned.removedSessionIds).toContain(oldSession.sessionId);
    expect(cleaned.keptActiveSessionId).toBe(activeSession.sessionId);

    await expect(runSessionStatus(runtime, { sessionId: oldSession.sessionId })).rejects.toThrow(
      "Session not found",
    );

    const activeStatus = await runSessionStatus(runtime, { sessionId: activeSession.sessionId });
    expect(activeStatus.status).toBe("ready");
  });
});
