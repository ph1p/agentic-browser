import crypto from "node:crypto";

import { MemoryIndex } from "./memory-index.js";
import { applyFailure, applySuccess, detectStalenessSignal } from "./staleness-detector.js";
import { TaskInsightStore } from "./task-insight-store.js";
import type {
  EvidenceRecord,
  MemorySearchResult,
  SelectorAlias,
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

const SEARCH_CACHE_TTL_MS = 2000;

export class MemoryService {
  private readonly store: TaskInsightStore;
  private readonly index: MemoryIndex;

  /** Simple TTL cache for search results keyed by intent+domain+limit. */
  private searchCache = new Map<string, { results: MemorySearchResult[]; ts: number }>();

  constructor(baseDir: string) {
    this.store = new TaskInsightStore(baseDir);
    this.index = new MemoryIndex();
  }

  /** Force an immediate synchronous flush of pending writes. */
  flushSync(): void {
    this.store.flushSync();
  }

  search(input: MemorySearchInput): MemorySearchResult[] {
    const cacheKey = `${input.taskIntent}\0${input.siteDomain ?? ""}\0${input.limit ?? 10}`;
    const now = Date.now();
    const cached = this.searchCache.get(cacheKey);
    if (cached && now - cached.ts < SEARCH_CACHE_TTL_MS) {
      return cached.results;
    }
    const results = this.index.search(this.store.list(), input);
    this.searchCache.set(cacheKey, { results, ts: now });
    return results;
  }

  /** Invalidate search cache when data changes. */
  private invalidateSearchCache(): void {
    this.searchCache.clear();
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
    this.invalidateSearchCache();
    return verified;
  }

  recordSuccess(input: RecordExecutionInput): TaskInsight {
    const insights = this.store.list();
    const matched = this.findBestExactMatch(insights, input);
    const evidence = this.createEvidence(input, "success");

    if (!matched) {
      const now = new Date().toISOString();
      let created: TaskInsight = {
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
        selectorAliases: [],
      };
      created = this.maybeGenerateAliases(created);
      this.store.upsert(created);
      this.invalidateSearchCache();
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
      let versioned: TaskInsight = {
        ...refreshed,
        insightId: crypto.randomUUID(),
        supersedes: matched.insightId,
        staleStrikeCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      versioned = this.maybeGenerateAliases(versioned);
      this.store.upsert(versioned);
      this.invalidateSearchCache();
      return versioned;
    }

    const withAliases = this.maybeGenerateAliases(refreshed);
    this.store.upsert(withAliases);
    this.invalidateSearchCache();
    return withAliases;
  }

  recordFailure(input: RecordExecutionInput, errorMessage: string): TaskInsight | undefined {
    const insights = this.store.list();
    const matched = this.findBestExactMatch(insights, input);
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
    this.invalidateSearchCache();
    return failed;
  }

  private findBestExactMatch(
    insights: TaskInsight[],
    input: Pick<RecordExecutionInput, "taskIntent" | "siteDomain" | "sitePathPattern" | "selector">,
  ): TaskInsight | undefined {
    const intentLower = input.taskIntent.toLowerCase();
    const domainLower = input.siteDomain.toLowerCase();
    let best: TaskInsight | undefined;
    for (const insight of insights) {
      if (
        insight.taskIntent.toLowerCase() === intentLower &&
        insight.siteDomain.toLowerCase() === domainLower
      ) {
        if (
          !best ||
          this.scoreExactMatch(insight, input) > this.scoreExactMatch(best, input) ||
          (this.scoreExactMatch(insight, input) === this.scoreExactMatch(best, input) &&
            insight.updatedAt > best.updatedAt)
        ) {
          best = insight;
        }
      }
    }
    return best;
  }

  private scoreExactMatch(
    insight: TaskInsight,
    input: Pick<RecordExecutionInput, "sitePathPattern" | "selector">,
  ): number {
    let score = 0;

    if (insight.sitePathPattern === input.sitePathPattern) {
      score += 4;
    } else if (
      insight.sitePathPattern === "/" ||
      input.sitePathPattern === "/" ||
      this.sameFirstPathSegment(insight.sitePathPattern, input.sitePathPattern)
    ) {
      score += 2;
    }

    if (input.selector) {
      if (insight.actionRecipe.some((step) => step.selector === input.selector)) {
        score += 3;
      }
      if (
        insight.evidence.some((ev) => ev.selector === input.selector && ev.result === "success")
      ) {
        score += 2;
      }
      if ((insight.selectorAliases ?? []).some((alias) => alias.selector === input.selector)) {
        score += 1;
      }
    }

    score += Math.min(insight.successCount, 5) * 0.1;
    score -= Math.min(insight.failureCount, 5) * 0.1;
    return score;
  }

  private sameFirstPathSegment(left: string, right: string): boolean {
    const normalize = (value: string): string => {
      const [firstSegment = ""] = value.replace(/\/\*$/, "").split("/").filter(Boolean);
      return firstSegment.toLowerCase();
    };

    const leftSegment = normalize(left);
    const rightSegment = normalize(right);
    return Boolean(leftSegment) && leftSegment === rightSegment;
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

  private maybeGenerateAliases(insight: TaskInsight): TaskInsight {
    if (insight.confidence < 0.8 || insight.successCount < 3) {
      return insight;
    }

    const aliasMap = new Map<string, SelectorAlias>();

    // Preserve existing aliases
    for (const existing of insight.selectorAliases ?? []) {
      aliasMap.set(existing.selector, existing);
    }

    // Derive aliases from recipe selectors and successful evidence selectors
    const selectors = new Set<string>();
    for (const step of insight.actionRecipe) {
      if (step.selector) selectors.add(step.selector);
    }
    for (const ev of insight.evidence) {
      if (ev.selector && ev.result === "success") selectors.add(ev.selector);
    }

    for (const selector of selectors) {
      if (aliasMap.has(selector)) continue;
      const alias = this.deriveAliasName(selector);
      if (alias) {
        aliasMap.set(selector, { alias, selector, fallbackSelectors: [] });
      }
      if (aliasMap.size >= 10) break;
    }

    return { ...insight, selectorAliases: [...aliasMap.values()].slice(0, 10) };
  }

  private deriveAliasName(selector: string): string | undefined {
    // #id → id
    const idMatch = selector.match(/^#([\w-]+)$/);
    if (idMatch) return idMatch[1]!.replace(/[-_]/g, " ");

    // [name="value"] → value
    const nameMatch = selector.match(/\[name="([^"]+)"\]/);
    if (nameMatch) return nameMatch[1]!;

    // [aria-label="value"] → value
    const ariaMatch = selector.match(/\[aria-label="([^"]+)"\]/);
    if (ariaMatch) return ariaMatch[1]!;

    // [data-testid="value"] → value
    const testIdMatch = selector.match(/\[data-testid="([^"]+)"\]/);
    if (testIdMatch) return testIdMatch[1]!;

    // [data-cy="value"] → value
    const cyMatch = selector.match(/\[data-cy="([^"]+)"\]/);
    if (cyMatch) return cyMatch[1]!;

    // [data-test="value"] → value
    const testMatch = selector.match(/\[data-test="([^"]+)"\]/);
    if (testMatch) return testMatch[1]!;

    return undefined;
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
