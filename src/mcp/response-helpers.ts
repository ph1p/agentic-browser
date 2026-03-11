import type {
  InteractiveElement,
  InteractiveElementsResult,
  PageContentMode,
  PageContentResult,
} from "../session/browser-controller.js";
import type { MemorySearchResult } from "../memory/memory-schemas.js";

function uniqueLines(content: string, maxLineLength = 160): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];

  for (const raw of content.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || seen.has(line)) continue;
    seen.add(line);
    lines.push(line.slice(0, maxLineLength));
  }

  return lines;
}

function truncateContent(content: string, limit?: number): { content: string; truncated: boolean } {
  if (!limit || content.length <= limit) {
    return { content, truncated: false };
  }

  const originalLength = content.length;
  return {
    content:
      content.slice(0, limit) +
      `\n\n[Truncated - showing first ${limit} of ${originalLength} characters. Use a CSS selector to scope the content, or use mode="summary" for a lower-token overview.]`,
    truncated: true,
  };
}

function resolveCompactedContent(
  result: PageContentResult,
  limit?: number,
): { content: string; truncated: boolean } {
  if (result.truncated) {
    return { content: result.content, truncated: true };
  }
  return truncateContent(result.content, limit);
}

function parseStructuredSummary(result: PageContentResult): Record<string, unknown> | undefined {
  if (result.structuredContent) {
    return result.structuredContent;
  }

  if (!result.content) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(result.content) as Record<string, unknown>;
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function summarizeTextContent(content: string): {
  summaryLines: string[];
  previewLines: string[];
} {
  const lines = uniqueLines(content);
  return {
    summaryLines: lines.slice(0, 8),
    previewLines: lines.slice(0, 20),
  };
}

function summarizeA11yContent(content: string): {
  headings: string[];
  landmarks: string[];
  actions: string[];
  inputs: string[];
  previewLines: string[];
} {
  const lines = uniqueLines(content);
  const headings: string[] = [];
  const landmarks: string[] = [];
  const actions: string[] = [];
  const inputs: string[] = [];

  for (const line of lines) {
    const lower = line.toLowerCase();
    if ((lower.startsWith("heading ") || lower.includes(" heading ")) && headings.length < 8) {
      headings.push(line);
      continue;
    }
    if (
      (lower.startsWith("main") ||
        lower.startsWith("navigation") ||
        lower.startsWith("banner") ||
        lower.startsWith("complementary") ||
        lower.startsWith("contentinfo") ||
        lower.startsWith("search")) &&
      landmarks.length < 8
    ) {
      landmarks.push(line);
      continue;
    }
    if ((lower.includes("button") || lower.includes("link")) && actions.length < 12) {
      actions.push(line);
      continue;
    }
    if (
      (lower.includes("textbox") ||
        lower.includes("combobox") ||
        lower.includes("searchbox") ||
        lower.includes("checkbox") ||
        lower.includes("radio")) &&
      inputs.length < 12
    ) {
      inputs.push(line);
    }
  }

  return {
    headings,
    landmarks,
    actions,
    inputs,
    previewLines: lines.slice(0, 30),
  };
}

export function compactPageContent(
  result: PageContentResult,
  maxChars?: number,
): Record<string, unknown> {
  const defaultMaxChars: Record<PageContentMode, number | undefined> = {
    text: 8000,
    a11y: 10000,
    html: 4000,
    title: undefined,
    summary: undefined,
  };
  const limit = maxChars ?? defaultMaxChars[result.mode];

  if (result.mode === "summary") {
    const structured = parseStructuredSummary(result);
    if (structured) {
      return { mode: "summary", ...structured, truncated: false };
    }
    return { mode: "summary", content: result.content, truncated: false };
  }

  const truncated = resolveCompactedContent(result, limit);

  if (result.mode === "title") {
    return { ...result, truncated: false };
  }

  if (result.mode === "text") {
    const summary = summarizeTextContent(truncated.content);
    return {
      mode: result.mode,
      content: truncated.content,
      truncated: truncated.truncated,
      originalLength: result.originalLength,
      summaryLines: summary.summaryLines,
      previewLines: summary.previewLines,
    };
  }

  if (result.mode === "a11y") {
    const summary = summarizeA11yContent(truncated.content);
    return {
      mode: result.mode,
      content: truncated.content,
      truncated: truncated.truncated,
      originalLength: result.originalLength,
      headings: summary.headings,
      landmarks: summary.landmarks,
      actions: summary.actions,
      inputs: summary.inputs,
      previewLines: summary.previewLines,
    };
  }

  return {
    mode: result.mode,
    content: truncated.content,
    truncated: truncated.truncated,
    originalLength: result.originalLength,
  };
}

function summarizeElements(elements: Array<Record<string, unknown>>) {
  const byRole = new Map<string, number>();
  const primaryActions: Array<Record<string, unknown>> = [];

  for (const element of elements) {
    const role = String(element.role ?? "unknown");
    byRole.set(role, (byRole.get(role) ?? 0) + 1);
    if (
      primaryActions.length < 12 &&
      typeof element.selector === "string" &&
      typeof element.text === "string" &&
      element.text
    ) {
      primaryActions.push({
        role,
        text: element.text,
        selector: element.selector,
        fallbackSelectors: element.fallbackSelectors,
      });
    }
  }

  return {
    countsByRole: Object.fromEntries([...byRole.entries()].sort((a, b) => b[1] - a[1])),
    primaryActions,
  };
}

function compactElement(
  element: InteractiveElement,
  visibleOnly: boolean,
): Record<string, unknown> {
  const compact: Record<string, unknown> = { ...element };

  if (visibleOnly) delete compact.visible;
  delete compact.actions;
  delete compact.tagName;
  if (compact.enabled === true) delete compact.enabled;
  if (!compact.text) delete compact.text;
  if (compact.ariaLabel && compact.ariaLabel === compact.text) delete compact.ariaLabel;
  if (compact.placeholder && compact.placeholder === compact.text) delete compact.placeholder;

  return compact;
}

export function compactInteractiveElementsResult(
  result: InteractiveElementsResult,
  visibleOnly: boolean,
): Record<string, unknown> {
  const elements = result.elements.map((el) => compactElement(el, visibleOnly));
  return {
    elements,
    totalFound: result.totalFound,
    truncated: result.truncated,
    summary: summarizeElements(elements),
  };
}

export function compactMemoryResults(results: MemorySearchResult[]): Record<string, unknown> {
  return {
    results: results.map((r) => {
      const compact: Record<string, unknown> = { ...r };
      delete compact.score;
      delete compact.lastVerifiedAt;
      if (Array.isArray(compact.selectorAliases)) {
        compact.selectorAliases = (compact.selectorAliases as Record<string, unknown>[]).map(
          (alias) => {
            const compactAlias = { ...alias };
            if (
              Array.isArray(compactAlias.fallbackSelectors) &&
              compactAlias.fallbackSelectors.length === 0
            ) {
              delete compactAlias.fallbackSelectors;
            }
            return compactAlias;
          },
        );
      }
      if (compact.siteProfile) {
        const profile = compact.siteProfile as Record<string, unknown>;
        compact.siteProfile = {
          selectorPatterns: (
            (profile.selectorPatterns ?? []) as Array<{ pattern: string; frequency: number }>
          ).map((p) => `${p.pattern} (x${p.frequency})`),
          cookieBanner: profile.cookieBanner,
          visitCount: profile.visitCount,
        };
      }
      return compact;
    }),
  };
}
