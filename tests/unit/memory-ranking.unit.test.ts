import { describe, expect, it } from "vitest";

import { MemoryIndex } from "../../src/memory/memory-index.js";
import type { TaskInsight } from "../../src/memory/memory-schemas.js";

function insight(overrides: Partial<TaskInsight>): TaskInsight {
  const now = new Date().toISOString();
  return {
    insightId: "i-1",
    taskIntent: "navigate:example.com",
    siteDomain: "example.com",
    sitePathPattern: "/",
    actionRecipe: [],
    expectedOutcome: "ok",
    confidence: 1,
    successCount: 1,
    failureCount: 0,
    useCount: 1,
    freshness: "fresh",
    staleStrikeCount: 0,
    lastVerifiedAt: now,
    createdAt: now,
    updatedAt: now,
    evidence: [],
    ...overrides,
  };
}

describe("memory ranking", () => {
  it("prioritizes exact intent and domain match", () => {
    const index = new MemoryIndex();
    const results = index.search(
      [
        insight({ insightId: "exact" }),
        insight({ insightId: "other-intent", taskIntent: "interact:example.com" }),
        insight({ insightId: "other-domain", siteDomain: "zalando.de" }),
      ],
      { taskIntent: "navigate:example.com", siteDomain: "example.com" },
    );

    expect(results[0]?.insightId).toBe("exact");
  });

  it("prioritizes insights with strong selector guidance when relevance is equal", () => {
    const index = new MemoryIndex();
    const results = index.search(
      [
        insight({
          insightId: "selector-rich",
          actionRecipe: [
            { type: "interact", summary: "open menu", selector: "#menu", payload: {} },
            { type: "interact", summary: "open profile", selector: ".profile-link", payload: {} },
          ],
          evidence: [
            {
              evidenceId: "e1",
              commandId: "c1",
              result: "success",
              selector: "#menu",
              recordedAt: new Date().toISOString(),
            },
          ],
        }),
        insight({
          insightId: "selector-poor",
          actionRecipe: [{ type: "navigate", summary: "go home", payload: {} }],
          evidence: [],
        }),
      ],
      { taskIntent: "navigate:example.com", siteDomain: "example.com" },
    );

    expect(results[0]?.insightId).toBe("selector-rich");
    expect(results[0]?.selectorHints).toContain("#menu");
  });
});
