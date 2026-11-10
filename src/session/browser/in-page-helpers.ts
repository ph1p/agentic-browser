/**
 * In-page visibility check shared by element discovery and cookie dismissal.
 * Uses the element's own window so it also works inside same-origin iframes.
 */
export const IN_PAGE_IS_VISIBLE = String.raw`
      function isVisible(el) {
        if (!el) return false;
        const view = (el.ownerDocument && el.ownerDocument.defaultView) || window;
        const style = view.getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }
`;

export const LOCATOR_RUNTIME_HELPERS = String.raw`
      const LOCATOR_SEPARATOR = ' >>> ';

      function splitLocator(locator) {
        return String(locator ?? '')
          .split(/\s*>>>\s*/g)
          .map((part) => part.trim())
          .filter(Boolean);
      }

      function getFrameElementForDocument(doc) {
        try {
          return doc && doc.defaultView && doc.defaultView.frameElement ? doc.defaultView.frameElement : null;
        } catch {
          return null;
        }
      }

      function createComposedChain(node) {
        const chain = [];
        let current = node;
        while (current) {
          chain.push(current);
          if (current.parentNode) {
            current = current.parentNode;
            continue;
          }
          if (current.host) {
            current = current.host;
            continue;
          }
          if (current.nodeType === Node.DOCUMENT_NODE) {
            current = getFrameElementForDocument(current);
            continue;
          }
          current = null;
        }
        return chain;
      }

      function isSameComposedTarget(left, right) {
        if (!left || !right) return false;
        const seen = new Set(createComposedChain(left));
        for (const current of createComposedChain(right)) {
          if (seen.has(current)) {
            return true;
          }
        }
        return false;
      }

      function isWithinComposedSubtree(root, candidate) {
        if (!root || !candidate) return false;
        for (const current of createComposedChain(candidate)) {
          if (current === root) {
            return true;
          }
        }
        return false;
      }

      const TEXT_INTERACTIVE_SELECTOR = [
        'a[href]', 'button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]',
        '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]', '[role="option"]',
        '[role="checkbox"]', '[role="radio"]', '[role="switch"]', 'summary', 'label', 'option',
        '[onclick]', '[tabindex]'
      ].join(',');

      function normalizeText(value) {
        return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      }

      function textLabels(el, useInnerText) {
        const labels = [];
        const body = useInnerText && typeof el.innerText === 'string' ? el.innerText : el.textContent;
        if (body) labels.push(normalizeText(body));
        for (const attr of ['aria-label', 'title', 'alt', 'placeholder']) {
          const value = el.getAttribute && el.getAttribute(attr);
          if (value) labels.push(normalizeText(value));
        }
        if (el.tagName && el.tagName.toLowerCase() === 'input' && typeof el.value === 'string' && el.value) {
          labels.push(normalizeText(el.value));
        }
        return labels;
      }

      function hasBox(el) {
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

      // text=Foo matches by visible text (exact first, then substring);
      // text="Foo" matches exactly. Interactive and visible elements win.
      function queryByText(root, query) {
        let raw = String(query).trim();
        let exactOnly = false;
        if (raw.length >= 2 && (raw[0] === '"' || raw[0] === "'") && raw[raw.length - 1] === raw[0]) {
          raw = raw.slice(1, -1);
          exactOnly = true;
        }
        const needle = normalizeText(raw);
        if (!needle) return null;

        function pick(candidates, useInnerText, preferSmallest) {
          let best = null;
          let bestScore = -1;
          let bestSize = Infinity;
          for (const el of candidates) {
            const labels = textLabels(el, useInnerText);
            let score = -1;
            if (labels.some((label) => label === needle)) score = 2;
            else if (!exactOnly && labels.some((label) => label.includes(needle))) score = 1;
            if (score < 0) continue;
            if (hasBox(el)) score += 4;
            const size = preferSmallest ? (el.textContent || '').length : 0;
            if (score > bestScore || (score === bestScore && size < bestSize)) {
              best = el;
              bestScore = score;
              bestSize = size;
            }
          }
          return best;
        }

        // On equal score the element with the least text is the most specific match.
        const interactive = pick(root.querySelectorAll(TEXT_INTERACTIVE_SELECTOR), true, true);
        if (interactive) return interactive;
        return pick(root.querySelectorAll(root.nodeType === 9 ? 'body *' : '*'), false, true);
      }

      function querySegment(root, part) {
        if (/^text=/i.test(part)) {
          return queryByText(root, part.slice(5));
        }
        return root.querySelector(part);
      }

      function resolveLocator(locator) {
        const parts = splitLocator(locator);
        if (parts.length === 0) return null;

        let root = document;
        let element = null;
        for (let index = 0; index < parts.length; index += 1) {
          element = querySegment(root, parts[index]);
          if (!element) return null;

          if (index === parts.length - 1) {
            return element;
          }

          if (element.tagName && element.tagName.toLowerCase() === 'iframe') {
            let nextDocument = null;
            try {
              nextDocument = element.contentDocument;
            } catch {
              nextDocument = null;
            }
            if (!nextDocument) {
              throw new Error('Unable to access iframe content for locator segment: ' + parts[index]);
            }
            root = nextDocument;
            continue;
          }

          if (element.shadowRoot) {
            root = element.shadowRoot;
            continue;
          }

          throw new Error('Locator segment does not enter a shadow root or iframe: ' + parts[index]);
        }

        return element;
      }

      function resolveWithFallbacks(selector, fallbacks) {
        let lastError = null;
        const locators = [];
        if (selector) locators.push(selector);
        if (Array.isArray(fallbacks)) {
          for (const fallback of fallbacks) {
            locators.push(fallback);
          }
        }

        for (const locator of locators) {
          try {
            const element = resolveLocator(locator);
            if (element) {
              return { element, locator };
            }
          } catch (error) {
            lastError = error;
          }
        }

        if (lastError) {
          throw lastError;
        }
        throw new Error('Element not found: ' + locators.join(' | '));
      }

      function ensureInView(element) {
        if (element && typeof element.scrollIntoView === 'function') {
          element.scrollIntoView({ block: 'center', inline: 'center' });
        }
      }

      function toMainFramePoint(element) {
        const rect = element.getBoundingClientRect();
        let x = rect.left + rect.width / 2;
        let y = rect.top + rect.height / 2;
        let doc = element.ownerDocument;

        while (doc) {
          const frameElement = getFrameElementForDocument(doc);
          if (!frameElement) {
            break;
          }
          const frameRect = frameElement.getBoundingClientRect();
          x += frameRect.left;
          y += frameRect.top;
          doc = frameElement.ownerDocument;
        }

        return { x, y, width: rect.width, height: rect.height };
      }

      function getTopFrameElement(element) {
        let topFrame = null;
        let doc = element.ownerDocument;
        while (doc) {
          const frameElement = getFrameElementForDocument(doc);
          if (!frameElement) {
            break;
          }
          topFrame = frameElement;
          doc = frameElement.ownerDocument;
        }
        return topFrame;
      }

      function describeElement(element) {
        if (!element || !element.tagName) return 'unknown';
        const tag = element.tagName.toLowerCase();
        const id = element.id ? '#' + element.id : '';
        const className =
          element.className && typeof element.className === 'string'
            ? '.' + element.className.trim().split(/\s+/).filter(Boolean).join('.')
            : '';
        return tag + id + className;
      }

      function deepActiveElement() {
        let current = document.activeElement;
        while (current) {
          if (current.shadowRoot && current.shadowRoot.activeElement) {
            current = current.shadowRoot.activeElement;
            continue;
          }
          if (current.tagName && current.tagName.toLowerCase() === 'iframe') {
            try {
              const frameActive = current.contentDocument && current.contentDocument.activeElement;
              if (frameActive) {
                current = frameActive;
                continue;
              }
            } catch {
              // ignore inaccessible frames
            }
          }
          break;
        }
        return current;
      }
`;

export function buildLocatorRuntimeExpression(
  inputName: string,
  inputValue: unknown,
  body: string,
): string {
  return `(async () => {
${LOCATOR_RUNTIME_HELPERS}
      const ${inputName} = ${JSON.stringify(inputValue)};
${body}
    })()`;
}
