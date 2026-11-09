import type {
  MemorySearchResult,
  RecipeStepSummary,
  SelectorAlias,
  SiteProfile,
  TaskInsight,
} from "./memory-schemas.js";

interface SearchInput {
  taskIntent: string;
  siteDomain?: string;
  limit?: number;
}

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "to",
  "on",
  "in",
  "of",
  "and",
  "or",
  "for",
  "with",
  "at",
  "my",
  "from",
  "by",
  "into",
]);

/**
 * Words of an intent, minus the site domain and filler words, with a trailing
 * plural "s" dropped — so "open the newest stories" and "newest story" share
 * tokens.
 */
function intentTokens(value: string, domain?: string): Set<string> {
  let text = normalize(value);
  if (domain) text = text.split(normalize(domain)).join(" ");
  const tokens = new Set<string>();
  for (const raw of text.split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || STOPWORDS.has(raw)) continue;
    tokens.add(raw.length > 3 && raw.endsWith("s") ? raw.slice(0, -1) : raw);
  }
  return tokens;
}

/** 0 = unrelated; 1 = identical intent. Word overlap covers rephrased queries. */
function intentSimilarity(insight: TaskInsight, normalizedIntent: string): number {
  const insightIntent = normalize(insight.taskIntent);
  if (insightIntent === normalizedIntent) return 1;
  if (insightIntent.includes(normalizedIntent) || normalizedIntent.includes(insightIntent)) {
    return 0.65;
  }
  const query = intentTokens(normalizedIntent);
  if (!query.size) return 0;
  const stored = intentTokens(insightIntent, insight.siteDomain);
  let shared = 0;
  for (const token of query) if (stored.has(token)) shared += 1;
  if (!shared) return 0;
  // Share of the query's words that the stored intent covers, scaled to 0.3–0.8.
  return 0.3 + 0.5 * (shared / query.size);
}

function buildRecipe(insight: TaskInsight): RecipeStepSummary[] {
  return insight.actionRecipe.map((step) => {
    const payload = step.payload ?? {};
    const action = typeof payload.action === "string" ? payload.action : step.type;
    const summary: RecipeStepSummary = { action };
    if (step.selector) summary.selector = step.selector;
    if (typeof payload.url === "string") summary.url = payload.url;
    if (payload.redacted === true) summary.needsInput = true;
    return summary;
  });
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
    .toSorted((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([selector]) => selector);
}

function buildSelectorAliases(insight: TaskInsight): SelectorAlias[] {
  return insight.selectorAliases ?? [];
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

interface ScoredInsight {
  result: MemorySearchResult;
  /** Intent-overlap strength (0 = no shared intent). Used to drop unrelated insights. */
  intentSignal: number;
}

function scoreInsight(
  insight: TaskInsight,
  normalizedIntent: string,
  normalizedDomain: string | undefined,
  profileLookup?: (domain: string) => SiteProfile | undefined,
): ScoredInsight {
  const intentSignal = intentSimilarity(insight, normalizedIntent);
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
    0.5 * intentSignal + 0.2 * domainMatch + 0.15 * reliability + 0.15 * selectorQuality;

  const result: MemorySearchResult = {
    insightId: insight.insightId,
    taskIntent: insight.taskIntent,
    siteDomain: insight.siteDomain,
    confidence: insight.confidence,
    freshness: insight.freshness,
    lastVerifiedAt: insight.lastVerifiedAt,
    recipe: buildRecipe(insight),
    selectorHints: buildSelectorHints(insight),
    selectorAliases: buildSelectorAliases(insight),
    score,
  };

  const profile = profileLookup?.(insight.siteDomain);
  if (profile) {
    result.siteProfile = {
      selectorPatterns: profile.selectorPatterns.slice(0, 5),
      layoutFingerprints: profile.layoutFingerprints.slice(0, 3),
      cookieBanner: profile.cookieBanner,
      visitCount: profile.visitCount,
    };
  }

  return { result, intentSignal };
}

export class MemoryIndex {
  /** Domain → insights index, rebuilt lazily when insight list changes. */
  private domainIndex = new Map<string, TaskInsight[]>();
  private indexedRefs: TaskInsight[] = [];

  /** Rebuild the domain index when the insight object set changes. */
  private ensureIndex(insights: TaskInsight[]): void {
    if (
      this.indexedRefs.length === insights.length &&
      insights.every((insight, index) => this.indexedRefs[index] === insight)
    ) {
      return;
    }

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
    this.indexedRefs = insights.slice();
  }

  search(
    insights: TaskInsight[],
    input: SearchInput,
    profileLookup?: (domain: string) => SiteProfile | undefined,
  ): MemorySearchResult[] {
    const normalizedIntent = normalize(input.taskIntent);
    const normalizedDomain = input.siteDomain ? normalize(input.siteDomain) : undefined;
    const limit = input.limit ?? 10;

    this.ensureIndex(insights);

    // When a domain is specified, only score insights for that domain (O(bucket) not O(n)).
    const candidates = normalizedDomain ? (this.domainIndex.get(normalizedDomain) ?? []) : insights;

    // Only return insights that share intent with the query — a domain match
    // alone (score >= 0.2) is not enough, otherwise "buy shoes" would surface
    // unrelated "login" insights for the same site.
    const relevant = (scored: ScoredInsight): boolean => scored.intentSignal > 0;

    // Fast path: limit=1 — pick the single best without allocating/sorting.
    if (limit === 1 && normalizedDomain) {
      let best: ScoredInsight | undefined;
      for (const insight of candidates) {
        const scored = scoreInsight(insight, normalizedIntent, normalizedDomain, profileLookup);
        if (!relevant(scored)) continue;
        if (!best || scored.result.score > best.result.score) {
          best = scored;
          // 1.0 is the maximum score (0.5 intent + 0.2 domain + 0.15 + 0.15) —
          // nothing can beat it, so stop scanning.
          if (best.result.score >= 1) break;
        }
      }
      return best ? [best.result] : [];
    }

    const ranked = candidates
      .map((insight) => scoreInsight(insight, normalizedIntent, normalizedDomain, profileLookup))
      .filter(relevant)
      .toSorted((a, b) => b.result.score - a.result.score)
      .slice(0, limit)
      .map((scored) => scored.result);

    return ranked;
  }
}
