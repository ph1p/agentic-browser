import crypto from "node:crypto";

import { MemoryIndex } from "./memory-index.js";
import {
  applyAgeStaleness,
  applyFailure,
  applySuccess,
  detectStalenessSignal,
} from "./staleness-detector.js";
import { redactUrlsInText } from "./redact-step-payload.js";
import { SiteProfileStore } from "./site-profile-store.js";
import { TaskInsightStore } from "./task-insight-store.js";
import {
  createEmptyProfile,
  classifySelectorPattern,
  findBestExactMatch,
  sanitizeInput,
  createEvidence,
  maybeGenerateAliases,
  mergeRecipe,
} from "./memory-helpers.js";
import type {
  MemorySearchResult,
  PageLayoutFingerprint,
  SiteProfile,
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
  /**
   * Run this step belongs to. A step from a new run starts the recipe over, so
   * the recipe is always the latest run's steps in order. Defaults to commandId.
   */
  runId?: string;
}

/** Memory service configuration */
const SEARCH_CACHE_TTL_MS = 2_000;
const MAX_EVIDENCE_RECORDS = 50;

/** Site profile limits */
const MAX_NAVIGATION_PATHS = 20;
const MAX_LAYOUT_FINGERPRINTS = 10;
const MAX_SELECTOR_PATTERNS = 15;

export class MemoryService {
  private readonly store: TaskInsightStore;
  private readonly profileStore: SiteProfileStore;
  private readonly index: MemoryIndex;

  /** Simple TTL cache for search results keyed by intent+domain+limit. */
  private searchCache = new Map<string, { results: MemorySearchResult[]; ts: number }>();

  constructor(baseDir: string) {
    this.store = new TaskInsightStore(baseDir);
    this.profileStore = new SiteProfileStore(baseDir);
    this.index = new MemoryIndex();
  }

  /** Force an immediate synchronous flush of pending writes. */
  flushSync(): void {
    this.store.flushSync();
    this.profileStore.flushSync();
  }

  /** Flush pending writes and release the stores' process exit hooks. */
  dispose(): void {
    this.store.dispose();
    this.profileStore.dispose();
  }

  search(input: MemorySearchInput): MemorySearchResult[] {
    const cacheKey = `${input.taskIntent}\0${input.siteDomain ?? ""}\0${input.limit ?? 10}`;
    const now = Date.now();
    const cached = this.searchCache.get(cacheKey);
    if (cached && now - cached.ts < SEARCH_CACHE_TTL_MS) {
      return cached.results;
    }

    // Lazy age-based staleness decay
    const insights = this.store.list();
    let mutated = false;
    for (let i = 0; i < insights.length; i++) {
      const decayed = applyAgeStaleness(insights[i]!);
      if (decayed.freshness !== insights[i]!.freshness) {
        insights[i] = decayed;
        this.store.upsert(decayed);
        mutated = true;
      }
    }
    if (mutated) this.searchCache.clear();

    const results = this.index.search(insights, input, (domain) => this.profileStore.get(domain));
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
        .toSorted((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([domain, count]) => ({ domain, count })),
    };
  }

  verify(insightId: string): TaskInsight {
    const insight = this.inspect(insightId);
    const now = new Date().toISOString();
    // Verification asserts the insight still works: restore full freshness and
    // clear accumulated staleness strikes, otherwise a "verified" insight would
    // stay down-ranked and one more strike would immediately re-stale it.
    const verified: TaskInsight = {
      ...insight,
      freshness: "fresh",
      staleStrikeCount: 0,
      lastVerifiedAt: now,
      updatedAt: now,
    };
    this.store.upsert(verified);
    this.invalidateSearchCache();
    return verified;
  }

  recordSuccess(rawInput: RecordExecutionInput): TaskInsight {
    const input = sanitizeInput(rawInput);
    this.updateSiteProfile(input.siteDomain, input.selector, input.url, input.sitePathPattern);

    const insights = this.store.list();
    const matched = findBestExactMatch(insights, input);
    const evidence = createEvidence(input, "success");

    if (!matched) {
      const now = new Date().toISOString();
      let created: TaskInsight = {
        insightId: crypto.randomUUID(),
        taskIntent: input.taskIntent,
        siteDomain: input.siteDomain,
        sitePathPattern: input.sitePathPattern,
        actionRecipe: [input.step],
        recipeRunId: input.runId ?? input.commandId,
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
      created = maybeGenerateAliases(created);
      this.store.upsert(created);
      this.invalidateSearchCache();
      return created;
    }

    const refreshed = applySuccess({
      ...matched,
      useCount: matched.useCount + 1,
      evidence: [...matched.evidence.slice(-(MAX_EVIDENCE_RECORDS - 1)), evidence],
      ...mergeRecipe(matched, input.step, input.runId ?? input.commandId),
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
      versioned = maybeGenerateAliases(versioned);
      this.store.upsert(versioned);
      // Drop the stale predecessor — otherwise search would return both the
      // ghost and its fresh replacement for the same intent+domain forever.
      this.store.remove(matched.insightId);
      this.invalidateSearchCache();
      return versioned;
    }

    const withAliases = maybeGenerateAliases(refreshed);
    this.store.upsert(withAliases);
    this.invalidateSearchCache();
    return withAliases;
  }

  recordFailure(rawInput: RecordExecutionInput, errorMessage: string): TaskInsight | undefined {
    const input = sanitizeInput(rawInput);
    this.updateSiteProfile(input.siteDomain, input.selector, input.url, input.sitePathPattern);

    const insights = this.store.list();
    const matched = findBestExactMatch(insights, input);
    if (!matched) {
      return undefined;
    }

    const signal = detectStalenessSignal(errorMessage, input.selector);
    const evidence = createEvidence(input, "failure", redactUrlsInText(errorMessage));

    const failed = applyFailure(
      {
        ...matched,
        useCount: matched.useCount + 1,
        evidence: [...matched.evidence.slice(-(MAX_EVIDENCE_RECORDS - 1)), evidence],
      },
      signal,
    );

    this.store.upsert(failed);
    this.invalidateSearchCache();
    return failed;
  }

  /** Update site profile from page content (call after getContent with mode="summary"). */
  updateProfileFromContent(
    domain: string,
    pathPattern: string,
    structuredContent: { headings?: string[]; landmarks?: string[] },
  ): void {
    if (!domain || domain === "unknown") return;
    const normalized = domain.toLowerCase();
    const now = new Date().toISOString();
    const profile = this.profileStore.get(normalized) ?? createEmptyProfile(normalized, now);

    const fingerprint: PageLayoutFingerprint = {
      pathPattern,
      headings: (structuredContent.headings ?? []).slice(0, 8),
      landmarks: (structuredContent.landmarks ?? []).slice(0, 8),
      lastSeenAt: now,
    };

    const fpIndex = profile.layoutFingerprints.findIndex((fp) => fp.pathPattern === pathPattern);
    if (fpIndex >= 0) {
      profile.layoutFingerprints[fpIndex] = fingerprint;
    } else {
      profile.layoutFingerprints.push(fingerprint);
      if (profile.layoutFingerprints.length > MAX_LAYOUT_FINGERPRINTS) {
        profile.layoutFingerprints = profile.layoutFingerprints
          .toSorted((a, b) => b.lastSeenAt.localeCompare(a.lastSeenAt))
          .slice(0, MAX_LAYOUT_FINGERPRINTS);
      }
    }

    profile.lastVisitAt = now;
    this.profileStore.upsert(profile);
  }

  /** Update site profile with cookie banner behavior. */
  updateProfileCookieBanner(
    domain: string,
    result: { dismissed: boolean; method?: string; detail?: string },
  ): void {
    if (!domain || domain === "unknown") return;
    const normalized = domain.toLowerCase();
    const now = new Date().toISOString();
    const profile = this.profileStore.get(normalized) ?? createEmptyProfile(normalized, now);

    profile.cookieBanner = {
      detected: true,
      autoDismissed: result.dismissed,
      method: result.method,
    };
    profile.lastVisitAt = now;
    this.profileStore.upsert(profile);
  }

  /** Look up a site profile by domain. */
  getSiteProfile(domain: string): SiteProfile | undefined {
    return this.profileStore.get(domain);
  }

  // ── private ──────────────────────────────────────────────────────

  private updateSiteProfile(
    domain: string,
    selector?: string,
    url?: string,
    pathPattern?: string,
  ): void {
    if (!domain || domain === "unknown") return;
    const normalized = domain.toLowerCase();
    const now = new Date().toISOString();
    const profile = this.profileStore.get(normalized) ?? createEmptyProfile(normalized, now);

    profile.visitCount += 1;
    profile.lastVisitAt = now;

    if (selector) {
      const pattern = classifySelectorPattern(selector);
      if (pattern) {
        const existing = profile.selectorPatterns.find((p) => p.pattern === pattern);
        if (existing) {
          existing.frequency += 1;
          existing.lastSeenAt = now;
        } else if (profile.selectorPatterns.length < MAX_SELECTOR_PATTERNS) {
          profile.selectorPatterns.push({ pattern, frequency: 1, lastSeenAt: now });
        }
      }
    }

    if (pathPattern && pathPattern !== "/") {
      if (
        !profile.navigationPaths.includes(pathPattern) &&
        profile.navigationPaths.length < MAX_NAVIGATION_PATHS
      ) {
        profile.navigationPaths.push(pathPattern);
      }
    }

    this.profileStore.upsert(profile);
  }
}
