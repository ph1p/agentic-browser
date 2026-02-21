import { describe, expect, it } from "vitest";

import { createDefaultRuntime } from "../../src/cli/runtime.js";
import { runSessionStart } from "../../src/cli/commands/session-start.js";
import { runSessionAuth } from "../../src/cli/commands/session-auth.js";

describe("US3 integration: token-protected command execution", () => {
  it("issues session token and validates it", async () => {
    const runtime = createDefaultRuntime();
    const started = await runSessionStart(runtime, { browser: "chrome" });

    const auth = await runSessionAuth(runtime, { sessionId: started.sessionId });
    expect(auth.token.length).toBeGreaterThan(10);
    expect(auth.valid).toBe(true);
  });
});
