import { describe, expect, it } from "vitest";

import { createDefaultRuntime } from "../../src/cli/runtime.js";
import { runSessionStart } from "../../src/cli/commands/session-start.js";
import { verifyBearerAuth } from "../../src/transport/auth-middleware.js";

describe("US3 contract: auth outcomes", () => {
  it("rejects invalid tokens and accepts valid tokens", async () => {
    const runtime = createDefaultRuntime();
    const started = await runSessionStart(runtime, { browser: "chrome" });

    expect(verifyBearerAuth(runtime.context.tokenService, started.sessionId, "invalid")).toBe(
      false,
    );
    expect(
      verifyBearerAuth(
        runtime.context.tokenService,
        started.sessionId,
        runtime.sessions.getAuthToken(started.sessionId),
      ),
    ).toBe(true);
  });
});
