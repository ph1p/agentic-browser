import { CONTENT_TRUNCATION_HINT } from "./page-eval.js";

export interface RuntimeContentPayload {
  content?: string;
  truncated?: boolean;
  originalLength?: number;
}

export function appendTruncationNotice(
  content: string,
  limit: number,
  originalLength: number,
): string {
  return (
    content +
    `\n\n[Truncated - showing first ${limit} of ${originalLength} characters. ${CONTENT_TRUNCATION_HINT}]`
  );
}

export function applyContentLimit(
  content: string,
  limit?: number,
  originalLength = content.length,
): { content: string; truncated: boolean; originalLength?: number } {
  if (!limit || originalLength <= limit) {
    return { content, truncated: false };
  }

  return {
    content: appendTruncationNotice(content.slice(0, limit), limit, originalLength),
    truncated: true,
    originalLength,
  };
}

export function normalizeRuntimeContentPayload(
  value: string | RuntimeContentPayload | undefined,
  limit?: number,
): { content: string; truncated?: boolean; originalLength?: number } {
  if (typeof value === "string") {
    const limited = applyContentLimit(value, limit);
    return {
      content: limited.content,
      truncated: limited.truncated || undefined,
      originalLength: limited.originalLength,
    };
  }

  const content = value?.content ?? "";
  if (value?.truncated) {
    const originalLength = value.originalLength ?? content.length;
    const effectiveLimit = limit && limit > 0 ? limit : content.length;
    return {
      content:
        content.includes("[Truncated - showing first") || effectiveLimit === 0
          ? content
          : appendTruncationNotice(content, effectiveLimit, originalLength),
      truncated: true,
      originalLength,
    };
  }

  const limited = applyContentLimit(content, limit, value?.originalLength ?? content.length);
  return {
    content: limited.content,
    truncated: limited.truncated || undefined,
    originalLength: limited.originalLength,
  };
}
