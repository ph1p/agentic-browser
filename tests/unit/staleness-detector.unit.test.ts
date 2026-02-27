import { describe, expect, it } from "vitest";

import {
  applyFailure,
  applySuccess,
  detectStalenessSignal,
} from "../../src/memory/staleness-detector.js";
import type { TaskInsight } from "../../src/memory/memory-schemas.js";

function insight(): TaskInsight {
  const now = new Date().toISOString();
  return {
    insightId: "i-1",
    taskIntent: "navigate:example.com",
    siteDomain: "example.com",
    sitePathPattern: "/",
    actionRecipe: [],
    expectedOutcome: "ok",
    confidence: 1,
    successCount: 3,
    failureCount: 0,
    useCount: 1,
    freshness: "fresh",
    staleStrikeCount: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    evidence: [],
    selectorAliases: [],
  };
}

describe("staleness detector", () => {
  it("marks insight suspect on first structural failure and stale on repeated failures", () => {
    const signal = detectStalenessSignal("Selector not found", "button.buy");
    const suspect = applyFailure(insight(), signal);
    expect(suspect.freshness).toBe("suspect");

    const stale = applyFailure(suspect, signal);
    expect(stale.freshness).toBe("stale");
  });

  it("resets freshness and strikes on success", () => {
    const signal = detectStalenessSignal("Selector not found");
    const suspect = applyFailure(insight(), signal);
    const fresh = applySuccess(suspect);
    expect(fresh.freshness).toBe("fresh");
    expect(fresh.staleStrikeCount).toBe(0);
  });

  it("treats navigation/dialog action errors as non-structural", () => {
    for (const msg of ["no history to go back", "no history to go forward", "no dialog present"]) {
      const signal = detectStalenessSignal(msg);
      expect(signal.isStructural).toBe(false);
      const result = applyFailure(insight(), signal);
      expect(result.freshness).toBe("fresh");
      expect(result.staleStrikeCount).toBe(0);
    }
  });
});
