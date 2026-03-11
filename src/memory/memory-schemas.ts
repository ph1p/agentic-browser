import { z } from "zod";

export const InsightFreshnessSchema = z.enum(["fresh", "suspect", "stale"]);

export const TaskStepSchema = z.object({
  type: z.enum(["navigate", "interact", "assert"]),
  summary: z.string().min(1),
  selector: z.string().optional(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const EvidenceRecordSchema = z.object({
  evidenceId: z.string().min(1),
  commandId: z.string().min(1),
  result: z.enum(["success", "failure"]),
  reason: z.string().optional(),
  selector: z.string().optional(),
  url: z.string().optional(),
  recordedAt: z.string().datetime(),
});

export const SelectorAliasSchema = z.object({
  alias: z.string().min(1),
  selector: z.string().min(1),
  fallbackSelectors: z.array(z.string()).default([]),
});

export const TaskInsightSchema = z.object({
  insightId: z.string().min(1),
  taskIntent: z.string().min(1),
  siteDomain: z.string().min(1),
  sitePathPattern: z.string().min(1),
  actionRecipe: z.array(TaskStepSchema),
  expectedOutcome: z.string().min(1),
  confidence: z.number().min(0).max(1),
  successCount: z.number().int().nonnegative(),
  failureCount: z.number().int().nonnegative(),
  useCount: z.number().int().nonnegative(),
  freshness: InsightFreshnessSchema,
  staleStrikeCount: z.number().int().nonnegative(),
  lastVerifiedAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  supersedes: z.string().optional(),
  evidence: z.array(EvidenceRecordSchema),
  selectorAliases: z.array(SelectorAliasSchema).default([]),
});

export const MemoryStateSchema = z.object({
  insights: z.array(TaskInsightSchema),
});

export const SelectorPatternSchema = z.object({
  pattern: z.string().min(1),
  frequency: z.number().int().nonnegative(),
  lastSeenAt: z.string().datetime(),
});

export const PageLayoutFingerprintSchema = z.object({
  pathPattern: z.string().min(1),
  headings: z.array(z.string()).default([]),
  landmarks: z.array(z.string()).default([]),
  lastSeenAt: z.string().datetime(),
});

export const SiteProfileSchema = z.object({
  domain: z.string().min(1),
  selectorPatterns: z.array(SelectorPatternSchema).default([]),
  layoutFingerprints: z.array(PageLayoutFingerprintSchema).default([]),
  navigationPaths: z.array(z.string()).default([]),
  cookieBanner: z
    .object({
      detected: z.boolean(),
      autoDismissed: z.boolean().optional(),
      method: z.string().optional(),
    })
    .optional(),
  visitCount: z.number().int().nonnegative().default(0),
  lastVisitAt: z.string().datetime(),
  createdAt: z.string().datetime(),
});

export const SiteProfileStateSchema = z.object({
  profiles: z.array(SiteProfileSchema),
});

export type InsightFreshness = z.infer<typeof InsightFreshnessSchema>;
export type TaskStep = z.infer<typeof TaskStepSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type SelectorAlias = z.infer<typeof SelectorAliasSchema>;
export type TaskInsight = z.infer<typeof TaskInsightSchema>;
export type MemoryState = z.infer<typeof MemoryStateSchema>;
export type SelectorPattern = z.infer<typeof SelectorPatternSchema>;
export type PageLayoutFingerprint = z.infer<typeof PageLayoutFingerprintSchema>;
export type SiteProfile = z.infer<typeof SiteProfileSchema>;
export type SiteProfileState = z.infer<typeof SiteProfileStateSchema>;

export interface SiteProfileSummary {
  selectorPatterns: SelectorPattern[];
  layoutFingerprints: PageLayoutFingerprint[];
  cookieBanner?: { detected: boolean; autoDismissed?: boolean; method?: string };
  visitCount: number;
}

export interface MemorySearchResult {
  insightId: string;
  taskIntent: string;
  siteDomain: string;
  confidence: number;
  freshness: InsightFreshness;
  lastVerifiedAt: string;
  selectorHints: string[];
  selectorAliases: SelectorAlias[];
  score: number;
  siteProfile?: SiteProfileSummary;
}
