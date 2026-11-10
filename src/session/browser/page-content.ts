import type { AccessibilityNode } from "./cdp-connection.js";
import { buildLocatorRuntimeExpression } from "./in-page-helpers.js";
import { getInteractiveElements } from "./interactive-elements.js";
import { evaluateOnPage } from "./page-eval.js";
import type { PageOps } from "./page-ops.js";
import type { InteractiveElementsResult, PageContentOptions, PageContentResult } from "./types.js";

export function summarizeInteractiveElements(result: InteractiveElementsResult): {
  primaryActions: Record<string, unknown>[];
  inputs: Record<string, unknown>[];
} {
  const primaryActions: Record<string, unknown>[] = [];
  const inputs: Record<string, unknown>[] = [];

  for (const element of result.elements) {
    if (
      primaryActions.length < 8 &&
      (element.role === "button" || element.role === "link" || element.role === "custom")
    ) {
      primaryActions.push({
        role: element.role,
        text: element.text,
        selector: element.selector,
        fallbackSelectors: element.fallbackSelectors,
        href: element.href,
      });
    }

    if (
      inputs.length < 8 &&
      (element.role === "input" ||
        element.role === "textarea" ||
        element.role === "select" ||
        element.role === "checkbox" ||
        element.role === "radio" ||
        element.role === "contenteditable")
    ) {
      inputs.push({
        role: element.role,
        text: element.text,
        selector: element.selector,
        fallbackSelectors: element.fallbackSelectors,
        inputType: element.inputType,
        placeholder: element.placeholder,
        ariaLabel: element.ariaLabel,
        currentValue: element.currentValue,
      });
    }

    if (primaryActions.length >= 8 && inputs.length >= 8) {
      break;
    }
  }

  return { primaryActions, inputs };
}

export async function getSummaryContent(
  ctx: PageOps,
  targetWsUrl: string,
  options: PageContentOptions,
): Promise<PageContentResult> {
  const expression = buildLocatorRuntimeExpression(
    "options",
    options,
    `
    const scopeSelector = options.selector;
    let scopeRoot = document.body ?? document.documentElement;
    if (scopeSelector) {
      try {
        scopeRoot = resolveLocator(scopeSelector) ?? scopeRoot;
      } catch {
        scopeRoot = scopeRoot ?? document.documentElement;
      }
    }

    function escapeAttr(value) {
      return String(value ?? '').replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
    }

    function uniqueValues(values, limit) {
      const seen = new Set();
      const results = [];
      for (const value of values) {
        const normalized = String(value ?? '').replace(/\\s+/g, ' ').trim();
        if (!normalized || seen.has(normalized)) continue;
        seen.add(normalized);
        results.push(normalized.slice(0, 160));
        if (results.length >= limit) break;
      }
      return results;
    }

    function textOf(el) {
      if (!el) return '';
      const ariaLabel = el.getAttribute && el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel;
      const text = el.innerText || el.textContent || '';
      return text.replace(/\\s+/g, ' ').trim();
    }

    function frameSelector(frame) {
      if (frame.id) return '#' + CSS.escape(frame.id);
      const name = frame.getAttribute('name');
      if (name) return 'iframe[name="' + escapeAttr(name) + '"]';
      const title = frame.getAttribute('title');
      if (title) return 'iframe[title="' + escapeAttr(title) + '"]';
      const src = frame.getAttribute('src');
      if (src) return 'iframe[src="' + escapeAttr(src) + '"]';
      const parent = frame.parentElement;
      if (!parent) return 'iframe';
      const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === frame.tagName);
      if (siblings.length === 1) return 'iframe';
      return 'iframe:nth-of-type(' + (siblings.indexOf(frame) + 1) + ')';
    }

    const headingSelectors = 'h1,h2,h3,h4,h5,h6,[role="heading"]';
    const landmarkSelectors = [
      'main',
      'nav',
      'aside',
      'header',
      'footer',
      '[role="main"]',
      '[role="navigation"]',
      '[role="banner"]',
      '[role="complementary"]',
      '[role="contentinfo"]',
      '[role="search"]'
    ].join(',');
    const alertSelectors = '[role="alert"], [aria-live="assertive"], dialog[open], [aria-modal="true"]';

    const headings = uniqueValues(
      Array.from(scopeRoot.querySelectorAll(headingSelectors)).map((el) => textOf(el)),
      8
    );
    const landmarks = uniqueValues(
      Array.from(scopeRoot.querySelectorAll(landmarkSelectors)).map((el) => {
        const role = el.getAttribute('role') || el.tagName.toLowerCase();
        const label = textOf(el);
        return label ? role + ' "' + label.slice(0, 80) + '"' : role;
      }),
      8
    );
    const alerts = uniqueValues(
      Array.from(scopeRoot.querySelectorAll(alertSelectors)).map((el) => textOf(el)),
      6
    );

    const allFrames = Array.from(scopeRoot.querySelectorAll('iframe'));
    const frames = allFrames.slice(0, 8).map((frame) => {
      let sameOrigin = false;
      try {
        sameOrigin = !!frame.contentDocument;
      } catch {
        sameOrigin = false;
      }

      return {
        selector: frameSelector(frame),
        name: frame.getAttribute('name') || undefined,
        title: frame.getAttribute('title') || undefined,
        src: frame.getAttribute('src') || frame.src || undefined,
        sameOrigin,
      };
    });

    // Extract a readable content excerpt so the LLM understands what the page is about
    function extractContentExcerpt(root, maxChars) {
      const skipTags = new Set(['SCRIPT','STYLE','NOSCRIPT','SVG','PATH','META','LINK','BR','HR','IMG']);
      const blocks = [];
      let totalChars = 0;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: function(node) {
          const parent = node.parentElement;
          if (!parent) return NodeFilter.FILTER_REJECT;
          if (skipTags.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
          const view = (parent.ownerDocument && parent.ownerDocument.defaultView) ? parent.ownerDocument.defaultView : window;
          const style = view.getComputedStyle(parent);
          if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      let node;
      while ((node = walker.nextNode())) {
        const text = node.textContent.replace(/\\s+/g, ' ').trim();
        if (!text || text.length < 2) continue;
        if (totalChars + text.length > maxChars) {
          const remaining = maxChars - totalChars;
          if (remaining > 20) blocks.push(text.slice(0, remaining));
          break;
        }
        blocks.push(text);
        totalChars += text.length;
      }
      return blocks.join(' ').replace(/\\s+/g, ' ').trim();
    }

    // Group inputs by their parent form for contextual understanding
    function discoverForms(root) {
      const forms = [];
      for (const form of Array.from(root.querySelectorAll('form')).slice(0, 6)) {
        const formInputs = Array.from(form.querySelectorAll('input:not([type="hidden"]), select, textarea'));
        if (!formInputs.length) continue;
        const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        forms.push({
          action: form.getAttribute('action') || undefined,
          method: (form.getAttribute('method') || 'get').toUpperCase(),
          fields: formInputs.slice(0, 10).map(function(el) {
            const tag = el.tagName.toLowerCase();
            return {
              name: el.getAttribute('name') || undefined,
              type: tag === 'select' ? 'select' : tag === 'textarea' ? 'textarea' : (el.type || 'text'),
              label: (function() {
                const id = el.id;
                if (id) {
                  const label = root.querySelector('label[for="' + CSS.escape(id) + '"]');
                  if (label) return textOf(label).slice(0, 60);
                }
                const closest = el.closest('label');
                if (closest) return textOf(closest).slice(0, 60);
                const ariaLabel = el.getAttribute('aria-label');
                if (ariaLabel) return ariaLabel.slice(0, 60);
                return el.getAttribute('placeholder') || undefined;
              })(),
              required: el.required || el.getAttribute('aria-required') === 'true' || false,
              currentValue: ('value' in el && typeof el.value === 'string' && el.value) ? el.value.slice(0, 100) : undefined,
            };
          }),
          submitText: submitBtn ? textOf(submitBtn).slice(0, 40) : undefined,
        });
      }
      return forms;
    }

    const contentExcerpt = extractContentExcerpt(scopeRoot, 1500);
    const forms = discoverForms(scopeRoot);

    return {
      url: window.location.href,
      title: document.title ?? '',
      contentExcerpt,
      headings,
      landmarks,
      forms: forms.length ? forms : undefined,
      alerts,
      frames,
      crossOriginFrameCount: allFrames.filter((frame) => {
        try {
          return !frame.contentDocument;
        } catch {
          return true;
        }
      }).length,
      hasMoreFrames: allFrames.length > frames.length,
      scopedToSelector: scopeSelector || undefined,
    };
`,
  );

  const pageSummary = await ctx.withRetry(targetWsUrl, async (conn) => {
    await ctx.ensureEnabled(targetWsUrl);
    const result = await evaluateOnPage<Record<string, unknown>>(conn, {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return result.result.value ?? {};
  });
  const elements = await getInteractiveElements(ctx, targetWsUrl, {
    selector: options.selector,
    visibleOnly: true,
    limit: 24,
  });
  const elementSummary = summarizeInteractiveElements(elements);

  return {
    mode: "summary",
    content: "",
    structuredContent: {
      mode: "summary",
      ...pageSummary,
      ...elementSummary,
      totalInteractiveElements: elements.totalFound,
      truncatedInteractiveElements: elements.truncated,
    },
  };
}

export function formatAccessibilityTree(nodes: AccessibilityNode[]): string {
  const childrenMap = new Map<string, string[]>();
  const nodeMap = new Map<string, AccessibilityNode>();
  for (const node of nodes) {
    nodeMap.set(node.nodeId, node);
    if (node.parentId) {
      const siblings = childrenMap.get(node.parentId);
      if (siblings) {
        siblings.push(node.nodeId);
      } else {
        childrenMap.set(node.parentId, [node.nodeId]);
      }
    }
  }

  const lines: string[] = [];

  const formatNode = (nodeId: string, depth: number): void => {
    const node = nodeMap.get(nodeId);
    if (!node) return;

    const role = node.role?.value ?? "unknown";
    const name = node.name?.value ?? "";
    const value = node.value?.value ?? "";

    if (node.ignored) {
      const children = childrenMap.get(nodeId) ?? node.childIds ?? [];
      for (const childId of children) {
        formatNode(childId, depth);
      }
      return;
    }

    const skip =
      !name && !value && (role === "generic" || role === "none" || role === "GenericContainer");
    if (!skip) {
      const indent = "  ".repeat(depth);
      let line = `${indent}${role}`;
      if (name) line += ` "${name}"`;
      if (value) line += ` value="${value}"`;

      if (node.properties) {
        for (const prop of node.properties) {
          if (prop.value.value === true) {
            line += ` [${prop.name}]`;
          } else if (prop.name === "checked" && prop.value.value === "mixed") {
            line += ` [indeterminate]`;
          }
        }
      }

      lines.push(line);
    }

    const children = childrenMap.get(nodeId) ?? node.childIds ?? [];
    for (const childId of children) {
      formatNode(childId, skip ? depth : depth + 1);
    }
  };

  const roots = nodes.filter((node) => !node.parentId || !nodeMap.has(node.parentId));
  for (const root of roots) {
    formatNode(root.nodeId, 0);
  }

  return lines.join("\n");
}

export async function getAccessibilityTree(
  ctx: PageOps,
  targetWsUrl: string,
  selector?: string,
): Promise<string> {
  return await ctx.withRetry(targetWsUrl, async (conn) => {
    await ctx.ensureEnabled(targetWsUrl);
    await conn.send("Accessibility.enable");

    let nodes: AccessibilityNode[];
    if (selector) {
      const objectGroup = "agentic-browser-a11y";
      const selected = await evaluateOnPage(conn, {
        expression: buildLocatorRuntimeExpression(
          "selector",
          selector,
          `
    return resolveLocator(selector);
`,
        ),
        // The locator expression is an async IIFE — without awaitPromise the
        // objectId would reference the pending Promise, not the element.
        awaitPromise: true,
        objectGroup,
      });
      const objectId = selected.result.objectId;
      if (!objectId || selected.result.subtype === "null") {
        try {
          await conn.send("Runtime.releaseObjectGroup", { objectGroup });
        } catch {
          // ignore cleanup failures
        }
        return "";
      }

      try {
        const partial = await conn.send<{ nodes: AccessibilityNode[] }>(
          "Accessibility.getPartialAXTree",
          {
            objectId,
            fetchRelatives: false,
          },
        );
        nodes = partial.nodes;
      } finally {
        try {
          await conn.send("Runtime.releaseObjectGroup", { objectGroup });
        } catch {
          // ignore cleanup failures
        }
      }
    } else {
      const full = await conn.send<{ nodes: AccessibilityNode[] }>("Accessibility.getFullAXTree");
      nodes = full.nodes;
    }

    return formatAccessibilityTree(nodes);
  });
}
