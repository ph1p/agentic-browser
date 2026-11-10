import type { CdpClient } from "./cdp-connection.js";
import { IN_PAGE_IS_VISIBLE, buildLocatorRuntimeExpression } from "./in-page-helpers.js";
import { evaluateOnPage } from "./page-eval.js";
import type { PageOps } from "./page-ops.js";
import type { InteractiveElementsOptions, InteractiveElementsResult } from "./types.js";

export async function getInteractiveElements(
  ctx: PageOps,
  targetWsUrl: string,
  options: InteractiveElementsOptions,
): Promise<InteractiveElementsResult> {
  const expression = buildLocatorRuntimeExpression(
    "options",
    options,
    `
    const visibleOnly = options.visibleOnly !== false;
    const limit = options.limit ?? 50;
    const scopeSelector = options.selector;
    const roleFilter = options.roles ? new Set(options.roles) : null;
    const hrefFilter = options.href ? String(options.href).toLowerCase() : '';
    const textFilter = options.text
      ? String(options.text).replace(/\\s+/g, ' ').trim().toLowerCase()
      : '';
    const candidateSelector = [
      'a[href]',
      'button',
      'input:not([type="hidden"])',
      'select',
      'textarea',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="radio"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="switch"]',
      '[onclick]',
      '[tabindex]',
      '[contenteditable="true"]',
      '[contenteditable=""]'
    ].join(',');

    let scopeElement = null;
    if (scopeSelector) {
      try {
        scopeElement = resolveLocator(scopeSelector) ?? document.body;
      } catch {
        scopeElement = document.body;
      }
    }

    function escapeAttr(value) {
      return value.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
    }

    function composeLocator(path, selector) {
      if (!path.length) return selector;
      return path.join(LOCATOR_SEPARATOR) + LOCATOR_SEPARATOR + selector;
    }

    function tryUniqueSelector(root, selector) {
      try {
        return root.querySelectorAll(selector).length === 1 ? selector : null;
      } catch {
        return null;
      }
    }

    function buildSelector(root, el) {
      if (el.id) return '#' + CSS.escape(el.id);

      const name = el.getAttribute('name');
      if (name) {
        const tag = el.tagName.toLowerCase();
        const byName = tag + '[name="' + escapeAttr(name) + '"]';
        const selector = tryUniqueSelector(root, byName);
        if (selector) return selector;
        // Radio/checkbox groups share a name; the value tells them apart.
        const value = el.getAttribute('value');
        if (value !== null) {
          const byValue = tryUniqueSelector(root, byName + '[value="' + escapeAttr(value) + '"]');
          if (byValue) return byValue;
        }
      }

      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
      if (testId) {
        const attr = el.hasAttribute('data-testid') ? 'data-testid' : 'data-test-id';
        const selector = tryUniqueSelector(root, '[' + attr + '="' + escapeAttr(testId) + '"]');
        if (selector) return selector;
      }

      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        const tag = el.tagName.toLowerCase();
        const selector = tryUniqueSelector(root, tag + '[aria-label="' + escapeAttr(ariaLabel) + '"]');
        if (selector) return selector;
      }

      const dataCy = el.getAttribute('data-cy');
      if (dataCy) {
        const selector = tryUniqueSelector(root, '[data-cy="' + escapeAttr(dataCy) + '"]');
        if (selector) return selector;
      }

      const dataTest = el.getAttribute('data-test');
      if (dataTest) {
        const selector = tryUniqueSelector(root, '[data-test="' + escapeAttr(dataTest) + '"]');
        if (selector) return selector;
      }

      const role = el.getAttribute('role');
      if (role && ariaLabel) {
        const selector = tryUniqueSelector(
          root,
          '[role="' + escapeAttr(role) + '"][aria-label="' + escapeAttr(ariaLabel) + '"]'
        );
        if (selector) return selector;
      }

      // A link's own href is usually unique and survives layout changes,
      // unlike a structural nth-of-type path (table layouts especially).
      const href = el.tagName === 'A' ? el.getAttribute('href') : null;
      if (href && href.length <= 120 && !href.startsWith('javascript:') && href !== '#') {
        const selector = tryUniqueSelector(root, 'a[href="' + escapeAttr(href) + '"]');
        if (selector) return selector;
      }

      const parts = [];
      let current = el;
      while (current && current.nodeType === 1) {
        const tag = current.tagName.toLowerCase();
        if (current !== el && current.id) {
          parts.unshift('#' + CSS.escape(current.id));
          break;
        }
        const parent = current.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const siblings = Array.from(parent.children).filter((candidate) => candidate.tagName === current.tagName);
        if (siblings.length === 1) {
          parts.unshift(tag);
        } else {
          const index = siblings.indexOf(current) + 1;
          parts.unshift(tag + ':nth-of-type(' + index + ')');
        }
        current = parent;
      }
      // Prefer the shortest unique tail of the path: long nth-of-type chains
      // cost tokens and break on the slightest layout change. A longer tail
      // matches a subset of a shorter one, so uniqueness is monotonic in the
      // tail length and a binary search finds the shortest unique tail.
      let best = parts.join(' > ');
      let lo = 1;
      let hi = parts.length - 1;
      while (lo <= hi) {
        const size = (lo + hi) >> 1;
        const candidate = tryUniqueSelector(root, parts.slice(-size).join(' > '));
        if (candidate) {
          best = candidate;
          hi = size - 1;
        } else {
          lo = size + 1;
        }
      }
      return best;
    }

    function buildFallbackSelectors(root, path, el, primarySelector) {
      const fallbacks = [];
      const candidates = [];

      if (el.id) candidates.push('#' + CSS.escape(el.id));

      const name = el.getAttribute('name');
      if (name) {
        const tag = el.tagName.toLowerCase();
        candidates.push(tag + '[name="' + escapeAttr(name) + '"]');
      }

      const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
      if (testId) {
        const attr = el.hasAttribute('data-testid') ? 'data-testid' : 'data-test-id';
        candidates.push('[' + attr + '="' + escapeAttr(testId) + '"]');
      }

      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) {
        const tag = el.tagName.toLowerCase();
        candidates.push(tag + '[aria-label="' + escapeAttr(ariaLabel) + '"]');
      }

      const dataCy = el.getAttribute('data-cy');
      if (dataCy) candidates.push('[data-cy="' + escapeAttr(dataCy) + '"]');

      const dataTest = el.getAttribute('data-test');
      if (dataTest) candidates.push('[data-test="' + escapeAttr(dataTest) + '"]');

      const role = el.getAttribute('role');
      if (role && ariaLabel) {
        candidates.push('[role="' + escapeAttr(role) + '"][aria-label="' + escapeAttr(ariaLabel) + '"]');
      }

      for (const candidate of candidates) {
        if (!tryUniqueSelector(root, candidate)) continue;
        const locator = composeLocator(path, candidate);
        if (locator === primarySelector) continue;
        fallbacks.push(locator);
        if (fallbacks.length >= 3) break;
      }
      return fallbacks;
    }

    function classifyRole(el) {
      const tag = el.tagName.toLowerCase();
      const ariaRole = el.getAttribute('role');
      if (tag === 'a') return 'link';
      if (tag === 'button' || ariaRole === 'button') return 'button';
      if (tag === 'input') {
        const type = (el.type || 'text').toLowerCase();
        if (type === 'checkbox') return 'checkbox';
        if (type === 'radio') return 'radio';
        return 'input';
      }
      if (tag === 'select') return 'select';
      if (tag === 'textarea') return 'textarea';
      if (el.isContentEditable) return 'contenteditable';
      if (ariaRole === 'link') return 'link';
      if (ariaRole === 'checkbox' || ariaRole === 'switch') return 'checkbox';
      if (ariaRole === 'radio') return 'radio';
      return 'custom';
    }

    function getActions(role, el) {
      switch (role) {
        case 'link':
        case 'button':
        case 'custom':
          return ['click'];
        case 'input': {
          const type = (el.type || 'text').toLowerCase();
          if (type === 'submit' || type === 'reset' || type === 'button' || type === 'file') {
            return ['click'];
          }
          return ['click', 'type', 'press'];
        }
        case 'textarea':
        case 'contenteditable':
          return ['click', 'type', 'press'];
        case 'select':
          return ['click', 'select'];
        case 'checkbox':
        case 'radio':
          return ['click', 'toggle'];
        default:
          return ['click'];
      }
    }

${IN_PAGE_IS_VISIBLE}

    // Form controls are named by their label (label[for] or a wrapping
    // <label>), not by their type or current value.
    function labelText(el) {
      const ids = el.getAttribute('aria-labelledby');
      if (ids) {
        const text = ids
          .split(/\\s+/)
          .map((id) => el.ownerDocument.getElementById(id)?.textContent?.trim())
          .filter(Boolean)
          .join(' ');
        if (text) return text;
      }
      for (const label of el.labels || []) {
        const clone = label.cloneNode(true);
        clone.querySelectorAll('input, select, textarea, button').forEach((n) => n.remove());
        const text = clone.textContent.replace(/\\s+/g, ' ').trim();
        if (text) return text;
      }
      return '';
    }

    function getText(el) {
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) return ariaLabel.slice(0, 80);

      const tag = el.tagName.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        const label = labelText(el);
        if (label) return label.slice(0, 80);
      }
      if (tag === 'input') {
        const value = el.value;
        if (value) return value.slice(0, 80);
        const placeholder = el.getAttribute('placeholder');
        if (placeholder) return placeholder.slice(0, 80);
        return el.type || 'text';
      }

      const directText = Array.from(el.childNodes)
        .filter((node) => node.nodeType === 3)
        .map((node) => node.textContent.trim())
        .filter(Boolean)
        .join(' ');
      if (directText) return directText.slice(0, 80);

      const innerText = (el.innerText || el.textContent || '').trim();
      if (innerText) return innerText.slice(0, 80);

      const title = el.getAttribute('title');
      if (title) return title.slice(0, 80);
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.slice(0, 80);
      const alt = el.getAttribute('alt');
      if (alt) return alt.slice(0, 80);
      // Icon-only controls: name them by the icon's label.
      const icon = el.querySelector('[aria-label], [title], img[alt]');
      if (icon) {
        const label =
          icon.getAttribute('aria-label') || icon.getAttribute('title') || icon.getAttribute('alt');
        if (label) return label.trim().slice(0, 80);
      }
      return '';
    }

    function isEnabled(el) {
      if ('disabled' in el && el.disabled) return false;
      const ariaDisabled = el.getAttribute('aria-disabled');
      return ariaDisabled !== 'true';
    }

    function rootEntries(root) {
      if (!root) return [];
      if (root.nodeType === Node.DOCUMENT_NODE) {
        if (root.body) return [root.body];
        if (root.documentElement) return [root.documentElement];
        return [];
      }
      if (root.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
        return Array.from(root.children || []);
      }
      return [root];
    }

    const candidates = [];
    const crossOriginFrames = [];
    let totalFound = 0;

    function maybeRecordElement(root, path, el) {
      if (scopeElement && !isWithinComposedSubtree(scopeElement, el)) {
        return;
      }

      if (!el.matches(candidateSelector)) {
        return;
      }

      const role = classifyRole(el);
      if (roleFilter && !roleFilter.has(role)) return;

      const visible = isVisible(el);
      if (visibleOnly && !visible) return;

      if (hrefFilter) {
        const href = typeof el.href === 'string' ? el.href : el.getAttribute('href');
        if (!href || !String(href).toLowerCase().includes(hrefFilter)) return;
      }
      if (textFilter) {
        const haystack = [
          el.innerText || el.textContent || '',
          el.getAttribute('aria-label'),
          el.getAttribute('placeholder'),
          el.getAttribute('title'),
          typeof el.value === 'string' ? el.value : '',
        ]
          .filter(Boolean)
          .join(' ')
          .replace(/\\s+/g, ' ')
          .toLowerCase();
        if (!haystack.includes(textFilter)) return;
      }

      totalFound += 1;
      candidates.push({ root, path, el, role, visible, rank: rankElement(el, visible) });
    }

    // Lower rank sorts first: main content, then the rest of the page, then
    // site chrome (header, nav, footer), then hidden elements. Ties keep
    // document order.
    // Region flags per ancestor, memoized so siblings share the walk up the
    // tree instead of each element running three closest() scans.
    const FOOTER = 1, MAIN = 2, CHROME = 4;
    const regionMemo = new Map();
    function regionFlags(el) {
      if (!el) return 0;
      let flags = regionMemo.get(el);
      if (flags !== undefined) return flags;
      flags = regionFlags(el.parentElement);
      if (el.matches('footer, [role="contentinfo"]')) flags |= FOOTER;
      if (el.matches('main, [role="main"], article')) flags |= MAIN;
      if (el.matches('header, nav, [role="banner"], [role="navigation"]')) flags |= CHROME;
      regionMemo.set(el, flags);
      return flags;
    }
    // Pages without landmarks (table layouts, old sites) still have a top
    // bar of site links: the first row near the top holding several links.
    // Its bottom edge is cached per document; elements above it are chrome.
    const headerBottomMemo = new Map();
    function headerBarBottom(doc) {
      let bottom = headerBottomMemo.get(doc);
      if (bottom !== undefined) return bottom;
      bottom = 0;
      if (!doc.querySelector('main, [role="main"], article, header, nav, [role="banner"], [role="navigation"]')) {
        const view = doc.defaultView || window;
        const rows = new Map();
        for (const link of doc.querySelectorAll('a[href], button')) {
          const rect = link.getBoundingClientRect();
          const top = Math.round(rect.top + view.scrollY);
          if (top > 200 || rect.width === 0) continue;
          const row = rows.get(top) || { count: 0, bottom: 0 };
          row.count++;
          row.bottom = Math.max(row.bottom, rect.bottom + view.scrollY);
          rows.set(top, row);
        }
        const firstDense = [...rows.entries()].sort((a, b) => a[0] - b[0]).find(([, row]) => row.count >= 4);
        if (firstDense) bottom = firstDense[1].bottom;
      }
      headerBottomMemo.set(doc, bottom);
      return bottom;
    }
    function inHeaderBar(el) {
      const bottom = headerBarBottom(el.ownerDocument);
      if (!bottom) return false;
      const view = el.ownerDocument.defaultView || window;
      return el.getBoundingClientRect().top + view.scrollY < bottom;
    }
    function rankElement(el, visible) {
      if (!visible) return 3;
      const flags = regionFlags(el);
      if (flags & FOOTER) return 2;
      if (flags & MAIN) return 0;
      if (flags & CHROME) return 2;
      if (inHeaderBar(el)) return 2;
      return 1;
    }

    function buildEntry(candidate) {
      const { root, path, el, role, visible } = candidate;
      const selector = composeLocator(path, buildSelector(root, el));
      const entry = {
        selector,
        role,
        tagName: el.tagName.toLowerCase(),
        text: getText(el),
        actions: getActions(role, el),
        visible,
        enabled: isEnabled(el),
      };

      const fallbacks = buildFallbackSelectors(root, path, el, selector);
      if (fallbacks.length) entry.fallbackSelectors = fallbacks;

      if (role === 'link' && el.href) entry.href = el.href;
      if (role === 'input') entry.inputType = (el.type || 'text').toLowerCase();
      const ariaLabel = el.getAttribute('aria-label');
      if (ariaLabel) entry.ariaLabel = ariaLabel;
      const placeholder = el.getAttribute('placeholder');
      if (placeholder) entry.placeholder = placeholder;
      if ('value' in el && typeof el.value === 'string' && el.value) {
        entry.currentValue = el.value.slice(0, 200);
      }

      return entry;
    }

    // Depth-first in document order, so a capped listing follows reading
    // order instead of favouring shallow page chrome.
    function walkRoot(root, path) {
      const stack = rootEntries(root).slice().reverse();
      while (stack.length) {
        const current = stack.pop();
        if (!current || current.nodeType !== 1) continue;

        maybeRecordElement(root, path, current);

        if (current.shadowRoot) {
          walkRoot(current.shadowRoot, path.concat(buildSelector(root, current)));
        }

        if (current.tagName && current.tagName.toLowerCase() === 'iframe') {
          let frameDocument = null;
          try {
            frameDocument = current.contentDocument;
          } catch {
            frameDocument = null;
          }
          if (frameDocument) {
            walkRoot(frameDocument, path.concat(buildSelector(root, current)));
          } else if (crossOriginFrames.length < 20 && isVisible(current)) {
            // Cross-origin: not walkable from here, report it so callers can pass it as frame.
            const info = { selector: composeLocator(path, buildSelector(root, current)) };
            const title = current.getAttribute('title');
            if (title) info.title = title.slice(0, 80);
            if (current.src) info.src = String(current.src).slice(0, 200);
            crossOriginFrames.push(info);
          }
        }

        const children = current.children;
        for (let i = children.length - 1; i >= 0; i -= 1) {
          stack.push(children[i]);
        }
      }
    }

    walkRoot(document, []);
    // Array sort is stable, so ties keep document order.
    candidates.sort((a, b) => a.rank - b.rank);
    const results = candidates.slice(0, limit).map(buildEntry);
    const output = { elements: results, totalFound, truncated: totalFound > results.length };
    if (crossOriginFrames.length) output.crossOriginFrames = crossOriginFrames;
    return output;
`,
  );

  const emptyResult: InteractiveElementsResult = {
    elements: [],
    totalFound: 0,
    truncated: false,
  };

  const extract = (raw: { result: { value?: unknown } }): InteractiveElementsResult => {
    const v = raw.result.value;
    if (v && typeof v === "object" && Array.isArray((v as InteractiveElementsResult).elements)) {
      return v as InteractiveElementsResult;
    }
    return emptyResult;
  };

  return await ctx.withRetry(targetWsUrl, async (conn) => {
    await ctx.ensureEnabled(targetWsUrl);
    const evaluate = async (client: CdpClient) =>
      extract(
        await evaluateOnPage<unknown>(client, {
          expression,
          returnByValue: true,
          // The expression is an async IIFE — without awaitPromise the pending
          // Promise serializes to {} and every call reports zero elements.
          awaitPromise: true,
        }),
      );
    if (!options.frame) return await evaluate(conn);

    const scope = await ctx.openFrameScope(conn, targetWsUrl, options.frame);
    try {
      const inner = await evaluate(scope.client);
      // Prefix with the frame so returned selectors work from the top page as-is.
      const withPrefix = (selector: string) => `${options.frame} >>> ${selector}`;
      return {
        ...inner,
        elements: inner.elements.map((element) => ({
          ...element,
          selector: withPrefix(element.selector),
          fallbackSelectors: element.fallbackSelectors?.map(withPrefix),
        })),
        crossOriginFrames: inner.crossOriginFrames?.map((frame) => ({
          ...frame,
          selector: withPrefix(frame.selector),
        })),
      };
    } finally {
      scope.release();
    }
  });
}
