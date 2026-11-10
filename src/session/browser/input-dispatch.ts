import type { CdpClient } from "./cdp-connection.js";
import { buildLocatorRuntimeExpression } from "./in-page-helpers.js";
import { buildKeyDispatchPayload } from "./keyboard.js";
import { evaluateOnPage } from "./page-eval.js";
import type { InteractPayload } from "./types.js";

export async function preparePointerTarget(
  conn: CdpClient,
  payload: InteractPayload,
): Promise<{ x: number; y: number }> {
  const expression = buildLocatorRuntimeExpression(
    "payload",
    payload,
    `
    const resolved = resolveWithFallbacks(payload.selector, payload.fallbackSelectors);
    const el = resolved.element;
    ensureInView(el);

    const point = toMainFramePoint(el);
    if (point.width === 0 && point.height === 0) {
      throw new Error('Element has zero size - it may be hidden or not rendered');
    }

    const topEl = document.elementFromPoint(point.x, point.y);
    const topFrame = getTopFrameElement(el);
    if (topEl && !isSameComposedTarget(topEl, el) && (!topFrame || topEl !== topFrame)) {
      throw new Error('Element is covered by another element: ' + describeElement(topEl));
    }

    return { x: point.x, y: point.y };
`,
  );

  const result = await evaluateOnPage<{ x?: number; y?: number }>(conn, {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  const point = result.result.value;
  if (!point || typeof point.x !== "number" || typeof point.y !== "number") {
    throw new Error("Unable to resolve pointer target");
  }
  return { x: point.x, y: point.y };
}

export async function prepareTypeTarget(
  conn: CdpClient,
  payload: InteractPayload,
): Promise<"ready" | "cleared"> {
  const expression = buildLocatorRuntimeExpression(
    "payload",
    payload,
    `
    const resolved = resolveWithFallbacks(payload.selector, payload.fallbackSelectors);
    const el = resolved.element;
    ensureInView(el);

    const point = toMainFramePoint(el);
    if (point.width === 0 && point.height === 0) {
      throw new Error('Element has zero size - it may be hidden or not rendered');
    }

    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? (el.type || 'text').toLowerCase() : '';
    const editable =
      el.isContentEditable ||
      tag === 'textarea' ||
      (tag === 'input' &&
        !['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'hidden'].includes(inputType));

    if (!editable) {
      throw new Error('Element is not text-editable');
    }

    if (typeof el.focus === 'function') {
      el.focus();
    }

    if ((payload.text ?? '') === '') {
      if (el.isContentEditable) {
        el.textContent = '';
      } else if ('value' in el) {
        el.value = '';
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return 'cleared';
    }

    if (el.isContentEditable) {
      const selection = el.ownerDocument.getSelection ? el.ownerDocument.getSelection() : null;
      if (selection) {
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(el);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    } else if (typeof el.select === 'function') {
      el.select();
    }

    return 'ready';
`,
  );

  const result = await evaluateOnPage<"ready" | "cleared">(conn, {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });

  const value = result.result.value;
  if (value !== "ready" && value !== "cleared") {
    throw new Error("Unable to resolve type target");
  }
  return value;
}

/**
 * Arm a wait for a main-frame navigation BEFORE the click is dispatched, so
 * the start event cannot be missed. Resolves "navigated" once the main frame
 * started loading and then committed/loaded (each stage timeout-tolerant),
 * or "none" when no main-frame load started within 500 ms.
 */
export async function armMainFrameNavigationWait(
  conn: CdpClient,
): Promise<{ result: Promise<"navigated" | "none"> }> {
  const matching = conn.waitForEventMatching?.bind(conn);
  if (!matching) {
    // Legacy behavior for clients without predicate waits.
    const legacy = (async (): Promise<"navigated" | "none"> => {
      try {
        const legacyWindowMs = 50;
        await conn.waitForEvent("Page.frameNavigated", legacyWindowMs);
      } catch {
        return "none";
      }
      try {
        await Promise.race([
          conn.waitForEvent("Page.loadEventFired", 3000),
          conn.waitForEvent("Page.frameStoppedLoading", 3000),
        ]);
      } catch {
        // load didn't fire in time — page may still be usable
      }
      return "navigated";
    })();
    return { result: legacy };
  }

  let mainFrameId: string | undefined;
  try {
    const tree = await conn.send<{ frameTree?: { frame?: { id?: string } } }>("Page.getFrameTree");
    mainFrameId = tree.frameTree?.frame?.id;
  } catch {
    // unknown main frame id — accept any frame's start event
  }
  const isMain = (params: { frameId?: string }): boolean =>
    mainFrameId === undefined || params.frameId === mainFrameId;

  const started = matching<{ frameId?: string }>("Page.frameStartedLoading", isMain, 500).then(
    () => true,
    () => false,
  );

  const result = (async (): Promise<"navigated" | "none"> => {
    if (!(await started)) return "none";
    // Arm both stages right after the start event; the next CDP message is
    // a separate macrotask, so nothing can slip between them.
    const navigated = matching<{ frame?: { parentId?: string } }>(
      "Page.frameNavigated",
      (params) => !params.frame?.parentId,
      5000,
    ).catch(() => undefined);
    const loaded = Promise.race([
      matching<{ frameId?: string }>("Page.frameStoppedLoading", isMain, 5000),
      matching<unknown>("Page.loadEventFired", () => true, 5000),
    ]).catch(() => undefined);
    await navigated;
    await loaded;
    return "navigated";
  })();
  return { result };
}

export async function dispatchMouseClick(conn: CdpClient, x: number, y: number): Promise<void> {
  await conn.send("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x,
    y,
    button: "none",
  });
  await conn.send("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
  await conn.send("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x,
    y,
    button: "left",
    clickCount: 1,
  });
}

export async function focusTarget(conn: CdpClient, payload: InteractPayload): Promise<void> {
  if (!payload.selector) {
    return;
  }

  const expression = buildLocatorRuntimeExpression(
    "payload",
    payload,
    `
    const resolved = resolveWithFallbacks(payload.selector, payload.fallbackSelectors);
    const el = resolved.element;
    ensureInView(el);
    if (typeof el.focus === 'function') {
      el.focus();
    }
    return true;
`,
  );

  await evaluateOnPage(conn, {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
}

export async function dispatchKeyPress(conn: CdpClient, keyInput?: string): Promise<void> {
  const payload = buildKeyDispatchPayload(keyInput ?? "Enter");
  await conn.send("Input.dispatchKeyEvent", {
    type: payload.text ? "keyDown" : "rawKeyDown",
    key: payload.key,
    code: payload.code,
    windowsVirtualKeyCode: payload.windowsVirtualKeyCode,
    nativeVirtualKeyCode: payload.nativeVirtualKeyCode,
    text: payload.text,
    unmodifiedText: payload.unmodifiedText,
  });
  await conn.send("Input.dispatchKeyEvent", {
    type: "keyUp",
    key: payload.key,
    code: payload.code,
    windowsVirtualKeyCode: payload.windowsVirtualKeyCode,
    nativeVirtualKeyCode: payload.nativeVirtualKeyCode,
  });
}
