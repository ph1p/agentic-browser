import type { MemorySearchResult, TaskInsight } from "./memory-schemas.js";

interface SearchInput {
  taskIntent: string;
  siteDomain?: string;
  limit?: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function freshnessWeight(freshness: TaskInsight["freshness"]): number {
  if (freshness === "fresh") return 1;
  if (freshness === "suspect") return 0.65;
  return 0.3;
}

function confidenceFromCounts(successCount: number, failureCount: number): number {
  const total = successCount + failureCount;
  if (total === 0) return 0.5;
  return successCount / total;
}

function buildSelectorHints(insight: TaskInsight): string[] {
  const weightedSelectors = new Map<string, number>();

  for (const step of insight.actionRecipe) {
    if (!step.selector) continue;
    weightedSelectors.set(step.selector, (weightedSelectors.get(step.selector) ?? 0) + 2);
  }

  for (const evidence of insight.evidence) {
    if (!evidence.selector || evidence.result !== "success") continue;
    weightedSelectors.set(evidence.selector, (weightedSelectors.get(evidence.selector) ?? 0) + 3);
  }

  return [...weightedSelectors.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([selector]) => selector);
}

function selectorSignal(insight: TaskInsight): number {
  const recipeSelectors = insight.actionRecipe.filter((step) => Boolean(step.selector)).length;
  const recipeCoverage =
    insight.actionRecipe.length > 0 ? recipeSelectors / insight.actionRecipe.length : 0;

  const selectorEvidence = insight.evidence.filter(
    (record) => Boolean(record.selector) && record.result === "success",
  ).length;
  const evidenceStrength = Math.min(selectorEvidence / 5, 1);

  return 0.7 * recipeCoverage + 0.3 * evidenceStrength;
}

function scoreInsight(
  insight: TaskInsight,
  normalizedIntent: string,
  normalizedDomain: string | undefined,
): MemorySearchResult {
  const insightIntent = normalize(insight.taskIntent);
  const intentMatch = insightIntent === normalizedIntent ? 1 : 0;
  const intentPartial =
    intentMatch === 1 ||
    insightIntent.includes(normalizedIntent) ||
    normalizedIntent.includes(insightIntent)
      ? 0.65
      : 0;
  const domainMatch =
    normalizedDomain && normalize(insight.siteDomain) === normalizedDomain
      ? 1
      : normalizedDomain
        ? 0
        : 0.6;
  const reliability =
    0.6 * confidenceFromCounts(insight.successCount, insight.failureCount) +
    0.4 * freshnessWeight(insight.freshness);
  const selectorQuality = selectorSignal(insight);

  const score =
    0.5 * Math.max(intentMatch, intentPartial) +
    0.2 * domainMatch +
    0.15 * reliability +
    0.15 * selectorQuality;

  return {
    insightId: insight.insightId,
    taskIntent: insight.taskIntent,
    siteDomain: insight.siteDomain,
    confidence: insight.confidence,
    freshness: insight.freshness,
    lastVerifiedAt: insight.lastVerifiedAt,
    selectorHints: buildSelectorHints(insight),
    score,
  } satisfies MemorySearchResult;
}

export class MemoryIndex {
  /** Domain → insights index, rebuilt lazily when insight list changes. */
  private domainIndex = new Map<string, TaskInsight[]>();
  private indexedInsights: TaskInsight[] | null = null;
  private indexedLength = 0;

  /** Rebuild the domain index when the underlying array or its size changes. */
  private ensureIndex(insights: TaskInsight[]): void {
    if (this.indexedInsights === insights && this.indexedLength === insights.length) return;
    this.domainIndex.clear();
    for (const insight of insights) {
      const domain = normalize(insight.siteDomain);
      let bucket = this.domainIndex.get(domain);
      if (!bucket) {
        bucket = [];
        this.domainIndex.set(domain, bucket);
      }
      bucket.push(insight);
    }
    this.indexedInsights = insights;
    this.indexedLength = insights.length;
  }

  search(insights: TaskInsight[], input: SearchInput): MemorySearchResult[] {
    const normalizedIntent = normalize(input.taskIntent);
    const normalizedDomain = input.siteDomain ? normalize(input.siteDomain) : undefined;
    const limit = input.limit ?? 10;

    this.ensureIndex(insights);

    // When a domain is specified, only score insights for that domain (O(bucket) not O(n)).
    const candidates = normalizedDomain ? (this.domainIndex.get(normalizedDomain) ?? []) : insights;

    // Fast path: limit=1 with exact intent match — return immediately without sorting.
    if (limit === 1 && normalizedDomain) {
      let best: MemorySearchResult | undefined;
      for (const insight of candidates) {
        const result = scoreInsight(insight, normalizedIntent, normalizedDomain);
        if (result.score > 0 && (!best || result.score > best.score)) {
          best = result;
          // Perfect score shortcut: exact intent (0.5) + domain (0.2) = 0.7 baseline.
          // If score >= 0.95 we won't find anything better.
          if (best.score >= 0.95) break;
        }
      }
      return best ? [best] : [];
    }

    const ranked = candidates
      .map((insight) => scoreInsight(insight, normalizedIntent, normalizedDomain))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return ranked;
  }
}
