import type { TaskInsight } from "./memory-schemas.js";

const MAX_SUSPECT_STRIKES = 2;

export interface StalenessSignal {
  reason: string;
  selector?: string;
  isStructural: boolean;
}

export function detectStalenessSignal(errorMessage: string, selector?: string): StalenessSignal {
  const lowered = errorMessage.toLowerCase();
  const isStructural =
    lowered.includes("selector not found") ||
    lowered.includes("waitfor timeout") ||
    lowered.includes("session target is missing") ||
    lowered.includes("element has zero size") ||
    lowered.includes("element is covered by another element");

  return {
    reason: errorMessage,
    selector,
    isStructural,
  };
}

export function applyFailure(insight: TaskInsight, signal: StalenessSignal): TaskInsight {
  const now = new Date().toISOString();
  const nextStrike = signal.isStructural ? insight.staleStrikeCount + 1 : insight.staleStrikeCount;

  let freshness = insight.freshness;
  if (signal.isStructural && insight.freshness === "fresh") {
    freshness = "suspect";
  }
  if (signal.isStructural && nextStrike >= MAX_SUSPECT_STRIKES) {
    freshness = "stale";
  }

  const failureCount = insight.failureCount + 1;
  const confidence = insight.successCount / Math.max(1, insight.successCount + failureCount);

  return {
    ...insight,
    freshness,
    staleStrikeCount: nextStrike,
    failureCount,
    confidence,
    updatedAt: now,
  };
}

export function applySuccess(insight: TaskInsight): TaskInsight {
  const now = new Date().toISOString();
  const successCount = insight.successCount + 1;
  const confidence = successCount / Math.max(1, successCount + insight.failureCount);

  return {
    ...insight,
    freshness: "fresh",
    staleStrikeCount: 0,
    successCount,
    confidence,
    lastVerifiedAt: now,
    updatedAt: now,
  };
}
