import crypto from "node:crypto";
import { redactUrlsInText, stripUrl } from "./redact-step-payload.js";
import type {
  EvidenceRecord,
  SelectorAlias,
  SiteProfile,
  TaskInsight,
  TaskStep,
} from "./memory-schemas.js";
import type { RecordExecutionInput } from "./memory-service.js";

const MAX_RECIPE_STEPS = 8;
const MAX_SELECTOR_ALIASES = 10;

export function normalizePathSegment(value: string): string {
  const [firstSegment = ""] = value.replace(/\/\*$/, "").split("/").filter(Boolean);
  return firstSegment.toLowerCase();
}

export function createEmptyProfile(domain: string, now: string): SiteProfile {
  return {
    domain,
    selectorPatterns: [],
    layoutFingerprints: [],
    navigationPaths: [],
    visitCount: 0,
    lastVisitAt: now,
    createdAt: now,
  };
}

export function classifySelectorPattern(selector: string): string | undefined {
  if (selector.includes("[data-testid=")) return "data-testid";
  if (selector.includes("[data-cy=")) return "data-cy";
  if (selector.includes("[data-test=")) return "data-test";
  if (selector.includes("[aria-label=")) return "aria-label";
  if (selector.includes("[name=")) return "name-attribute";
  if (/^#[\w-]+$/.test(selector)) return "id-selector";
  if (selector.includes("[role=")) return "role-attribute";
  return undefined;
}

export function findBestExactMatch(
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
        scoreExactMatch(insight, input) > scoreExactMatch(best, input) ||
        (scoreExactMatch(insight, input) === scoreExactMatch(best, input) &&
          insight.updatedAt > best.updatedAt)
      ) {
        best = insight;
      }
    }
  }
  return best;
}

export function scoreExactMatch(
  insight: TaskInsight,
  input: Pick<RecordExecutionInput, "sitePathPattern" | "selector">,
): number {
  let score = 0;

  if (insight.sitePathPattern === input.sitePathPattern) {
    score += 4;
  } else if (
    insight.sitePathPattern === "/" ||
    input.sitePathPattern === "/" ||
    sameFirstPathSegment(insight.sitePathPattern, input.sitePathPattern)
  ) {
    score += 2;
  }

  if (input.selector) {
    if (insight.actionRecipe.some((step) => step.selector === input.selector)) {
      score += 3;
    }
    if (insight.evidence.some((ev) => ev.selector === input.selector && ev.result === "success")) {
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

export function sameFirstPathSegment(left: string, right: string): boolean {
  const leftSegment = normalizePathSegment(left);
  const rightSegment = normalizePathSegment(right);
  return Boolean(leftSegment) && leftSegment === rightSegment;
}

/** Strip query strings and fragments from every URL-bearing field before it is persisted. */
export function sanitizeInput(input: RecordExecutionInput): RecordExecutionInput {
  return {
    ...input,
    url: input.url ? (stripUrl(input.url) ?? undefined) : undefined,
    expectedOutcome: redactUrlsInText(input.expectedOutcome),
    taskIntent: redactUrlsInText(input.taskIntent),
  };
}

export function createEvidence(
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

export function maybeGenerateAliases(insight: TaskInsight): TaskInsight {
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
    const alias = deriveAliasName(selector);
    if (alias) {
      aliasMap.set(selector, { alias, selector, fallbackSelectors: [] });
    }
    if (aliasMap.size >= MAX_SELECTOR_ALIASES) break;
  }

  return { ...insight, selectorAliases: [...aliasMap.values()].slice(0, MAX_SELECTOR_ALIASES) };
}

export function deriveAliasName(selector: string): string | undefined {
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

/** Same run: append the step. New run: its first step replaces the old recipe. */
export function mergeRecipe(
  insight: TaskInsight,
  step: TaskStep,
  runId: string,
): Pick<TaskInsight, "actionRecipe" | "recipeRunId"> {
  if (insight.recipeRunId !== runId) return { actionRecipe: [step], recipeRunId: runId };
  return {
    actionRecipe: [...insight.actionRecipe, step].slice(-MAX_RECIPE_STEPS),
    recipeRunId: runId,
  };
}
