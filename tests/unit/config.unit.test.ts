import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/lib/config.js";

describe("loadConfig", () => {
  it("accepts the documented chrome executable env var", () => {
    const config = loadConfig({
      AGENTIC_BROWSER_CHROME_EXECUTABLE_PATH:
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    });

    expect(config.browserExecutablePath).toBe(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    );
  });
});
