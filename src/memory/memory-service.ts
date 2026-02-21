import crypto from "node:crypto";

import { MemoryIndex } from "./memory-index.js";
import { applyFailure, applySuccess, detectStalenessSignal } from "./staleness-detector.js";
import { TaskInsightStore } from "./task-insight-store.js";
import type {
  EvidenceRecord,
  MemorySearchResult,
  TaskInsight,
  TaskStep,
} from "./memory-schemas.js";

export interface MemorySearchInput {
  taskIntent: string;
  siteDomain?: string;
  limit?: number;
}

export interface RecordExecutionInput {
  commandId: string;
  taskIntent: string;
  siteDomain: string;
  sitePathPattern: string;
  step: TaskStep;
  expectedOutcome: string;
  url?: string;
  selector?: string;
}

export class MemoryService {
  private readonly store: TaskInsightStore;
  private readonly index: MemoryIndex;

  constructor(baseDir: string) {
    this.store = new TaskInsightStore(baseDir);
    this.index = new MemoryIndex();
  }

  search(input: MemorySearchInput): MemorySearchResult[] {
    return this.index.search(this.store.list(), input);
  }

  inspect(insightId: string): TaskInsight {
    const insight = this.store.get(insightId);
    if (!insight) {
      throw new Error("Insight not found");
    }
    return insight;
  }

  stats(): {
    total: number;
    fresh: number;
    suspect: number;
    stale: number;
    topDomains: Array<{ domain: string; count: number }>;
  } {
    const insights = this.store.list();
    const byDomain = new Map<string, number>();

    for (const insight of insights) {
      byDomain.set(insight.siteDomain, (byDomain.get(insight.siteDomain) ?? 0) + 1);
    }

    return {
      total: insights.length,
      fresh: insights.filter((x) => x.freshness === "fresh").length,
      suspect: insights.filter((x) => x.freshness === "suspect").length,
      stale: insights.filter((x) => x.freshness === "stale").length,
      topDomains: [...byDomain.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([domain, count]) => ({ domain, count })),
    };
  }

  verify(insightId: string): TaskInsight {
    const insight = this.inspect(insightId);
    const now = new Date().toISOString();
    const verified: TaskInsight = {
      ...insight,
      lastVerifiedAt: now,
      updatedAt: now,
    };
    this.store.upsert(verified);
    return verified;
  }

  recordSuccess(input: RecordExecutionInput): TaskInsight {
    const insights = this.store.list();
    const matched = this.findBestExactMatch(insights, input.taskIntent, input.siteDomain);
    const evidence = this.createEvidence(input, "success");

    if (!matched) {
      const now = new Date().toISOString();
      const created: TaskInsight = {
        insightId: crypto.randomUUID(),
        taskIntent: input.taskIntent,
        siteDomain: input.siteDomain,
        sitePathPattern: input.sitePathPattern,
        actionRecipe: [input.step],
        expectedOutcome: input.expectedOutcome,
        confidence: 1,
        successCount: 1,
        failureCount: 0,
        useCount: 1,
        freshness: "fresh",
        staleStrikeCount: 0,
        lastVerifiedAt: now,
        createdAt: now,
        updatedAt: now,
        evidence: [evidence],
      };
      this.store.upsert(created);
      return created;
    }

    const refreshed = applySuccess({
      ...matched,
      useCount: matched.useCount + 1,
      evidence: [...matched.evidence.slice(-49), evidence],
      actionRecipe: this.mergeRecipe(matched.actionRecipe, input.step),
      expectedOutcome: input.expectedOutcome,
    });

    if (matched.freshness === "suspect" || matched.freshness === "stale") {
      const now = new Date().toISOString();
      const versioned: TaskInsight = {
        ...refreshed,
        insightId: crypto.randomUUID(),
        supersedes: matched.insightId,
        staleStrikeCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.store.upsert(versioned);
      return versioned;
    }

    this.store.upsert(refreshed);
    return refreshed;
  }

  recordFailure(input: RecordExecutionInput, errorMessage: string): TaskInsight | undefined {
    const insights = this.store.list();
    const matched = this.findBestExactMatch(insights, input.taskIntent, input.siteDomain);
    if (!matched) {
      return undefined;
    }

    const signal = detectStalenessSignal(errorMessage, input.selector);
    const evidence = this.createEvidence(input, "failure", errorMessage);

    const failed = applyFailure(
      {
        ...matched,
        useCount: matched.useCount + 1,
        evidence: [...matched.evidence.slice(-49), evidence],
      },
      signal,
    );

    this.store.upsert(failed);
    return failed;
  }

  private findBestExactMatch(
    insights: TaskInsight[],
    taskIntent: string,
    siteDomain: string,
  ): TaskInsight | undefined {
    return insights
      .filter(
        (insight) =>
          insight.taskIntent.toLowerCase() === taskIntent.toLowerCase() &&
          insight.siteDomain.toLowerCase() === siteDomain.toLowerCase(),
      )
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  }

  private createEvidence(
    input: RecordExecutionInput,
    result: "success" | "failure",
    reason?: string,
  ): EvidenceRecord {
    return {
      evidenceId: crypto.randomUUID(),
      commandId: input.commandId,
      result,
      reason,
      selector: input.selector,
      url: input.url,
      recordedAt: new Date().toISOString(),
    };
  }

  private mergeRecipe(recipe: TaskStep[], step: TaskStep): TaskStep[] {
    const exists = recipe.find(
      (existing) => existing.summary === step.summary && existing.selector === step.selector,
    );
    if (exists) {
      return recipe;
    }
    return [...recipe, step].slice(-8);
  }
}
