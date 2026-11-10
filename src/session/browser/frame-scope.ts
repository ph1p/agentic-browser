import type { CdpClient } from "./cdp-connection.js";
import { getJson } from "./chrome-process.js";
import { buildLocatorRuntimeExpression } from "./in-page-helpers.js";
import { FRAME_CONTENT_OFFSET_FUNCTION, type FrameScope, evaluateOnPage } from "./page-eval.js";
import type { InteractPayload } from "./types.js";

/**
 * Split a composed locator at the first iframe whose document the page
 * cannot reach (cross-origin). Returns null when no such boundary exists.
 */
export async function splitAtCrossOriginFrame(
  conn: CdpClient,
  locator: string,
): Promise<{ frame: string; rest: string } | null> {
  if (!locator.includes(">>>")) return null;
  const result = await evaluateOnPage<{ frame: string; rest: string } | null>(conn, {
    expression: buildLocatorRuntimeExpression(
      "locator",
      locator,
      `
    const parts = splitLocator(locator);
    let root = document;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const el = querySegment(root, parts[index]);
      if (!el) return null;
      const tag = el.tagName ? el.tagName.toLowerCase() : '';
      if (tag === 'iframe' || tag === 'frame') {
        let doc = null;
        try {
          doc = el.contentDocument;
        } catch {
          doc = null;
        }
        if (!doc) {
          return {
            frame: parts.slice(0, index + 1).join(LOCATOR_SEPARATOR),
            rest: parts.slice(index + 1).join(LOCATOR_SEPARATOR),
          };
        }
        root = doc;
        continue;
      }
      if (el.shadowRoot) {
        root = el.shadowRoot;
        continue;
      }
      return null;
    }
    return null;
`,
    ),
    returnByValue: true,
    awaitPromise: true,
  });
  return result.result.value ?? null;
}

/**
 * Work out which frame a payload targets. An explicit `frame` wins;
 * otherwise a composed selector crossing a cross-origin iframe is split.
 */
export async function resolveFrameTarget(
  conn: CdpClient,
  payload: InteractPayload,
): Promise<{ frame?: string; payload: InteractPayload }> {
  if (payload.frame) return { frame: payload.frame, payload };
  if (!payload.selector) return { payload };
  const split = await splitAtCrossOriginFrame(conn, payload.selector);
  if (!split) return { payload };
  const prefix = split.frame + " >>> ";
  const fallbackSelectors = payload.fallbackSelectors?.map((fallback) =>
    fallback.startsWith(prefix) ? fallback.slice(prefix.length) : fallback,
  );
  return {
    frame: split.frame,
    payload: { ...payload, selector: split.rest, fallbackSelectors },
  };
}

/**
 * Open an evaluation scope inside an iframe. Same-process frames get an
 * isolated world on the page connection; out-of-process (cross-site) frames
 * get their own CDP connection to the frame target. Input events still go
 * to the page connection, translated by `getOffset()`.
 */
export async function openFrameScope(
  connectionFactory: (targetWsUrl: string) => Promise<CdpClient>,
  conn: CdpClient,
  targetWsUrl: string,
  frameLocator: string,
): Promise<FrameScope> {
  const located = await evaluateOnPage<unknown>(conn, {
    expression: buildLocatorRuntimeExpression(
      "frameLocator",
      frameLocator,
      `
    const el = resolveLocator(frameLocator);
    if (!el) throw new Error('Frame not found: ' + frameLocator);
    const tag = el.tagName ? el.tagName.toLowerCase() : '';
    if (tag !== 'iframe' && tag !== 'frame') {
      throw new Error('Frame locator does not match an iframe: ' + frameLocator);
    }
    ensureInView(el);
    return el;
`,
    ),
    awaitPromise: true,
  });
  const objectId = located.result.objectId;
  if (!objectId) throw new Error(`Frame not found: ${frameLocator}`);
  const releaseObject = () => {
    conn.send("Runtime.releaseObject", { objectId }).catch(() => {});
  };

  try {
    const described = await conn.send<{ node?: { frameId?: string } }>("DOM.describeNode", {
      objectId,
    });
    const frameId = described.node?.frameId;
    if (!frameId) throw new Error(`Frame has no document yet: ${frameLocator}`);

    const getOffset = async (): Promise<{ x: number; y: number }> => {
      const offset = await conn.send<{ result: { value?: { x: number; y: number } } }>(
        "Runtime.callFunctionOn",
        {
          objectId,
          functionDeclaration: FRAME_CONTENT_OFFSET_FUNCTION,
          returnByValue: true,
        },
      );
      return offset.result.value ?? { x: 0, y: 0 };
    };

    let world: { executionContextId?: number } | null = null;
    try {
      world = await conn.send<{ executionContextId?: number }>("Page.createIsolatedWorld", {
        frameId,
        worldName: "agentic-browser",
      });
    } catch {
      world = null; // out-of-process frame — the page session does not own it
    }

    if (world?.executionContextId !== undefined) {
      const contextId = world.executionContextId;
      const client: CdpClient = {
        send: (method, params, timeoutMs) =>
          conn.send(
            method,
            method === "Runtime.evaluate" ? { ...params, contextId } : params,
            timeoutMs,
          ),
        waitForEvent: (method, timeoutMs) => conn.waitForEvent(method, timeoutMs),
        close: () => {},
      };
      return { client, getOffset, release: releaseObject };
    }

    const frameWsUrl = targetWsUrl.replace(
      /\/devtools\/page\/[^/?#]+/,
      `/devtools/page/${frameId}`,
    );
    if (frameWsUrl === targetWsUrl) {
      throw new Error(`Cannot derive a frame target URL from ${targetWsUrl}`);
    }
    let frameConn: CdpClient | undefined;
    let lastError: unknown;
    // Chrome creates DevTools hosts for OOPIF targets lazily: /devtools/page/<frameId>
    // answers HTTP 500 until /json/list has enumerated them, so list and retry.
    const listUrl = targetWsUrl.replace(/^ws(s?):\/\/([^/]+)\/.*$/, "http$1://$2/json/list");
    for (let attempt = 0; attempt < 4 && !frameConn; attempt++) {
      if (attempt > 0) {
        await getJson<unknown>(listUrl).catch(() => {});
        if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
      try {
        frameConn = await connectionFactory(frameWsUrl);
      } catch (error) {
        lastError = error;
      }
    }
    if (!frameConn) {
      throw new Error(
        `Unable to attach to cross-origin frame ${frameLocator}: ${(lastError as Error)?.message}`,
        { cause: lastError },
      );
    }
    const attached = frameConn;
    return {
      client: attached,
      getOffset,
      release: () => {
        releaseObject();
        try {
          attached.close();
        } catch {
          // ignore close failures
        }
      },
    };
  } catch (error) {
    releaseObject();
    throw error;
  }
}
