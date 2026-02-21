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

export class MemoryIndex {
  search(insights: TaskInsight[], input: SearchInput): MemorySearchResult[] {
    const normalizedIntent = normalize(input.taskIntent);
    const normalizedDomain = input.siteDomain ? normalize(input.siteDomain) : undefined;
    const limit = input.limit ?? 10;

    const ranked = insights
      .map((insight) => {
        const intentMatch = normalize(insight.taskIntent) === normalizedIntent ? 1 : 0;
        const intentPartial =
          intentMatch === 1 ||
          normalize(insight.taskIntent).includes(normalizedIntent) ||
          normalizedIntent.includes(normalize(insight.taskIntent))
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
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    return ranked;
  }
}
