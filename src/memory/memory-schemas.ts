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
});

export const MemoryStateSchema = z.object({
  insights: z.array(TaskInsightSchema),
});

export type InsightFreshness = z.infer<typeof InsightFreshnessSchema>;
export type TaskStep = z.infer<typeof TaskStepSchema>;
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;
export type TaskInsight = z.infer<typeof TaskInsightSchema>;
export type MemoryState = z.infer<typeof MemoryStateSchema>;

export interface MemorySearchResult {
  insightId: string;
  taskIntent: string;
  siteDomain: string;
  confidence: number;
  freshness: InsightFreshness;
  lastVerifiedAt: string;
  selectorHints: string[];
  score: number;
}
