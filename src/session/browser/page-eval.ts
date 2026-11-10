import type { CdpClient } from "./cdp-connection.js";

export interface FrameScope {
  /** Evaluates inside the frame (Runtime.evaluate lands in the frame's context). */
  client: CdpClient;
  /** Frame viewport origin in main-frame CSS pixels — read after in-frame scrolling. */
  getOffset(): Promise<{ x: number; y: number }>;
  release(): void;
}

/** Called on the iframe element: origin of its content box in top-level viewport coordinates. */
export const FRAME_CONTENT_OFFSET_FUNCTION = `function () {
  const rect = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  let x = rect.left + this.clientLeft + (parseFloat(style.paddingLeft) || 0);
  let y = rect.top + this.clientTop + (parseFloat(style.paddingTop) || 0);
  let doc = this.ownerDocument;
  while (doc) {
    let frameElement = null;
    try {
      frameElement = doc.defaultView && doc.defaultView.frameElement;
    } catch {
      frameElement = null;
    }
    if (!frameElement) break;
    const frameRect = frameElement.getBoundingClientRect();
    x += frameRect.left + frameElement.clientLeft;
    y += frameRect.top + frameElement.clientTop;
    doc = frameElement.ownerDocument;
  }
  return { x, y };
}`;

export interface PageEvaluateResult<V> {
  result: { value?: V; objectId?: string; subtype?: string };
  exceptionDetails?: {
    text?: string;
    exception?: { description?: string; value?: unknown };
  };
}

/**
 * Run Runtime.evaluate and surface in-page exceptions as errors.
 * CDP reports page-side throws via `exceptionDetails` on an otherwise successful
 * response — callers that read `result.value` directly would treat a throw as an
 * empty (successful) result.
 */
export async function evaluateOnPage<V = unknown>(
  conn: CdpClient,
  params: Record<string, unknown>,
): Promise<PageEvaluateResult<V>> {
  const result = await conn.send<PageEvaluateResult<V>>("Runtime.evaluate", params);
  const details = result.exceptionDetails;
  if (details) {
    const raw =
      details.exception?.description ??
      (typeof details.exception?.value === "string" ? details.exception.value : undefined) ??
      details.text ??
      "Page evaluation failed";
    // description carries the stack trace — keep only the message line
    throw new Error(raw.split("\n")[0].replace(/^Error:\s*/, ""));
  }
  return result;
}

export interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt?: string;
}

export const CONTENT_TRUNCATION_HINT =
  'Use a CSS selector to scope the content, or use mode="summary" for a lower-token overview.';
