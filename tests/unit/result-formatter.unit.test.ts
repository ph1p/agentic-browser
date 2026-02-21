import { describe, expect, it } from "vitest";

import { formatResult } from "../../src/cli/output/result-formatter.js";

describe("formatResult", () => {
  it("returns deterministic payload", () => {
    expect(formatResult("success", "ok")).toEqual({ resultStatus: "success", message: "ok" });
  });
});
