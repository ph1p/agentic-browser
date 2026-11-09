import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { ensurePrivateDir } from "../lib/secure-fs.js";
import { discoverChrome } from "./chrome-launcher.js";

/**
 * Detect a running Chrome that owns `profileDir`. On macOS/Linux `SingletonLock`
 * is a dangling symlink to `<hostname>-<pid>`, so existsSync (which follows
 * symlinks) cannot see it; inspect the link itself and probe the pid.
 */
export function isProfileLocked(profileDir: string): { locked: boolean; pid?: number } {
  const lockFile = path.join(profileDir, "SingletonLock");
  let target: string;
  try {
    const st = fs.lstatSync(lockFile);
    if (!st.isSymbolicLink()) return { locked: true }; // unknown format: be conservative
    target = fs.readlinkSync(lockFile);
  } catch {
    return { locked: false }; // ENOENT
  }
  const pid = Number(target.slice(target.lastIndexOf("-") + 1));
  if (!Number.isInteger(pid) || pid <= 0) return { locked: true };
  try {
    process.kill(pid, 0);
    return { locked: true, pid };
  } catch (e) {
    // EPERM: process exists under another user. ESRCH: stale lock, Chrome clears it.
    return { locked: (e as NodeJS.ErrnoException).code === "EPERM", pid };
  }
}

export type InteractAction =
  | "click"
  | "type"
  | "press"
  | "waitFor"
  | "evaluate"
  | "scroll"
  | "hover"
  | "select"
  | "toggle"
  | "goBack"
  | "goForward"
  | "refresh"
  | "dialog";

export interface InteractPayload {
  action: InteractAction;
  selector?: string;
  fallbackSelectors?: string[];
  text?: string;
  key?: string;
  value?: string;
  scrollX?: number;
  scrollY?: number;
  timeoutMs?: number;
  /**
   * Locator of an iframe to run the action in. Needed for cross-origin frames,
   * which `>>>` cannot pierce from the page. Composed selectors like
   * `iframe#consent >>> button` are split automatically when the frame is
   * cross-origin, so this is only required for explicit control.
   */
  frame?: string;
}

export type PageContentMode = "title" | "text" | "html" | "a11y" | "summary";

export interface PageContentOptions {
  mode: PageContentMode;
  selector?: string;
  maxChars?: number;
}

export interface PageContentResult {
  mode: PageContentMode;
  content: string;
  truncated?: boolean;
  originalLength?: number;
  structuredContent?: Record<string, unknown>;
}

export type InteractiveElementRole =
  | "link"
  | "button"
  | "input"
  | "select"
  | "textarea"
  | "checkbox"
  | "radio"
  | "contenteditable"
  | "custom";

export type ElementAction = "click" | "type" | "select" | "toggle" | "press";

export interface InteractiveElement {
  selector: string;
  fallbackSelectors?: string[];
  role: InteractiveElementRole;
  tagName: string;
  text: string;
  actions: ElementAction[];
  visible: boolean;
  enabled: boolean;
  href?: string;
  inputType?: string;
  ariaLabel?: string;
  placeholder?: string;
  currentValue?: string;
  /** Short handle ("e3") usable in place of the selector until the page changes. */
  ref?: string;
}

export interface InteractiveElementsOptions {
  roles?: InteractiveElementRole[];
  visibleOnly?: boolean;
  limit?: number;
  selector?: string;
  /** Case-insensitive substring filter on the element's href. */
  href?: string;
  /** Case-insensitive substring filter on text, aria-label, placeholder, value or title. */
  text?: string;
  /** Discover elements inside this iframe (works for cross-origin frames). */
  frame?: string;
}

/** An iframe whose content discovery could not enter from the page context. */
export interface CrossOriginFrameInfo {
  selector: string;
  title?: string;
  src?: string;
}

export interface InteractiveElementsResult {
  elements: InteractiveElement[];
  totalFound: number;
  truncated: boolean;
  /** Cross-origin iframes skipped by discovery — pass one as `frame` to look inside. */
  crossOriginFrames?: CrossOriginFrameInfo[];
}

export interface PageState {
  url: string;
  title: string;
  readyState: string;
}

export interface TabInfo {
  id: string;
  url: string;
  title: string;
  targetWsUrl: string;
}

export interface LaunchOptions {
  executablePath?: string;
  userProfileDir?: string;
  headless?: boolean;
  userAgent?: string;
}

export interface DismissCookieBannerResult {
  dismissed: boolean;
  method?: "a11y" | "selector" | "text" | "iframe" | "iframe-text";
  detail?: string;
}

export type ErrorCode =
  | "SELECTOR_NOT_FOUND"
  | "ELEMENT_COVERED"
  | "ELEMENT_NOT_EDITABLE"
  | "NAVIGATION_TIMEOUT"
  | "NAVIGATION_FAILED"
  | "CDP_DISCONNECTED"
  | "SESSION_DEAD"
  | "DIALOG_BLOCKING"
  | "TIMEOUT"
  | "UNKNOWN";

export interface ScreenshotOptions {
  format?: "jpeg" | "png";
  quality?: number;
  fullPage?: boolean;
}

export interface ScreenshotResult {
  data: string;
  mimeType: string;
}

export interface BrowserController {
  launch(
    sessionId: string,
    options?: LaunchOptions,
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }>;
  connect(
    cdpUrl: string,
    options?: { userAgent?: string },
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }>;
  navigate(targetWsUrl: string, url: string): Promise<string>;
  interact(targetWsUrl: string, payload: InteractPayload): Promise<string>;
  getContent(targetWsUrl: string, options: PageContentOptions): Promise<PageContentResult>;
  getInteractiveElements(
    targetWsUrl: string,
    options: InteractiveElementsOptions,
  ): Promise<InteractiveElementsResult>;
  dismissCookieBanner(targetWsUrl: string): Promise<DismissCookieBannerResult>;
  screenshot(targetWsUrl: string, options?: ScreenshotOptions): Promise<ScreenshotResult>;
  getCurrentUrl(targetWsUrl: string): Promise<string>;
  getPageState(targetWsUrl: string): Promise<PageState>;
  listTabs(cdpUrl: string): Promise<TabInfo[]>;
  openTab(cdpUrl: string): Promise<TabInfo>;
  activateTab(cdpUrl: string, tabId: string): Promise<void>;
  closeTab(cdpUrl: string, tabId: string): Promise<void>;
  terminate(pid: number): void;
  closeConnection?(targetWsUrl: string): void;
  dispose?(): void;
}

interface CdpTarget {
  id: string;
  type: string;
  url?: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface AccessibilityNode {
  nodeId: string;
  parentId?: string;
  backendDOMNodeId?: number;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  description?: { value: string };
  properties?: Array<{ name: string; value: { value: unknown } }>;
  childIds?: string[];
  ignored?: boolean;
}

interface CdpClient {
  send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T>;
  waitForEvent<T = unknown>(method: string, timeoutMs?: number): Promise<T>;
  waitForEventMatching?<T = unknown>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs?: number,
  ): Promise<T>;
  onEvent?<T = unknown>(method: string, handler: (params: T) => void): () => void;
  close(): void;
}

export class CdpConnection implements CdpClient {
  private nextId = 0;
  private readonly pendingRequests = new Map<
    number,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly pendingEvents = new Map<
    string,
    Array<{
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timeout: ReturnType<typeof setTimeout>;
    }>
  >();
  private readonly eventHandlers = new Map<string, Set<(params: unknown) => void>>();
  private closed = false;

  constructor(private readonly ws: WebSocket) {
    this.ensureListening();
  }

  static async connect(targetWsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(targetWsUrl);
    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        ws.off("error", onError);
        resolve();
      };
      const onError = (err: Error) => {
        ws.off("open", onOpen);
        reject(err);
      };
      ws.once("open", onOpen);
      ws.once("error", onError);
    });
    return new CdpConnection(ws);
  }

  private ensureListening(): void {
    this.ws.on("message", this.handleMessage);
    this.ws.once("close", this.handleClose);
    this.ws.on("error", this.handleError);
  }

  private readonly handleMessage = (raw: WebSocket.RawData) => {
    let message: {
      id?: number;
      method?: string;
      result?: unknown;
      error?: { message: string };
      params?: unknown;
    };
    try {
      message = JSON.parse(raw.toString("utf8")) as typeof message;
    } catch {
      return;
    }

    if (typeof message.id === "number") {
      const pending = this.pendingRequests.get(message.id);
      if (!pending) {
        return;
      }
      this.pendingRequests.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) {
        pending.reject(new Error(message.error.message));
        return;
      }
      pending.resolve(message.result ?? {});
      return;
    }

    if (!message.method) {
      return;
    }

    const params = message.params ?? {};
    const handlers = this.eventHandlers.get(message.method);
    if (handlers) {
      for (const handler of handlers) {
        handler(params);
      }
    }

    const waiters = this.pendingEvents.get(message.method);
    if (!waiters?.length) {
      return;
    }
    this.pendingEvents.delete(message.method);
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(params);
    }
  };

  private readonly handleError = (err: Error) => {
    this.failAllPending(err);
  };

  private readonly handleClose = () => {
    this.failAllPending(new Error("CDP connection closed"));
  };

  private failAllPending(error: Error): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.ws.off("message", this.handleMessage);
    this.ws.off("error", this.handleError);

    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pendingRequests.clear();

    for (const waiters of this.pendingEvents.values()) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout);
        waiter.reject(error);
      }
    }
    this.pendingEvents.clear();
    this.eventHandlers.clear();
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      throw new Error(`WebSocket not open (state=${this.ws.readyState}), cannot send '${method}'`);
    }
    const id = ++this.nextId;
    const payload = { id, method, params };

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`CDP call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pendingRequests.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.ws.send(JSON.stringify(payload));
    });
  }

  waitForEvent<T = unknown>(method: string, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = this.pendingEvents.get(method);
        if (!waiters) {
          reject(new Error(`Timed out waiting for ${method}`));
          return;
        }
        const next = waiters.filter((waiter) => waiter.timeout !== timeout);
        if (next.length > 0) {
          this.pendingEvents.set(method, next);
        } else {
          this.pendingEvents.delete(method);
        }
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      const waiters = this.pendingEvents.get(method) ?? [];
      waiters.push({
        resolve: (value) => resolve(value as T),
        reject,
        timeout,
      });
      this.pendingEvents.set(method, waiters);
    });
  }

  /**
   * Resolve on the first event of `method` whose params satisfy `predicate`.
   * Uses the persistent onEvent channel so non-matching events (e.g. subframe
   * navigations) don't consume the wait.
   */
  waitForEventMatching<T = unknown>(
    method: string,
    predicate: (params: T) => boolean,
    timeoutMs = 5000,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let unsubscribe = () => {};
      const timeout = setTimeout(() => {
        unsubscribe();
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      unsubscribe = this.onEvent<T>(method, (params) => {
        if (!predicate(params)) return;
        clearTimeout(timeout);
        unsubscribe();
        resolve(params);
      });
    });
  }

  onEvent<T = unknown>(method: string, handler: (params: T) => void): () => void {
    const handlers = this.eventHandlers.get(method) ?? new Set<(params: unknown) => void>();
    const wrapped = (params: unknown) => {
      handler(params as T);
    };
    handlers.add(wrapped);
    this.eventHandlers.set(method, handlers);

    return () => {
      const current = this.eventHandlers.get(method);
      if (!current) return;
      current.delete(wrapped);
      if (current.size === 0) {
        this.eventHandlers.delete(method);
      }
    };
  }

  close(): void {
    this.failAllPending(new Error("CDP connection closed"));
    this.ws.close();
  }
}

async function getJson<T>(url: string, timeoutMs = 5000): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${url}`);
  }
  return (await response.json()) as T;
}

/** Debugger connection timing */
const DEBUGGER_READY_TIMEOUT_MS = 15_000;
const DEBUGGER_INITIAL_RETRY_DELAY_MS = 50;
const DEBUGGER_MAX_RETRY_DELAY_MS = 250;

/** Check if the debug port is accepting TCP connections (faster than an HTTP fetch). */
function probePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForDebugger(port: number): Promise<void> {
  const start = Date.now();
  let delay = DEBUGGER_INITIAL_RETRY_DELAY_MS;

  while (Date.now() - start < DEBUGGER_READY_TIMEOUT_MS) {
    // Quick TCP probe first — much cheaper than an HTTP round-trip.
    if (await probePort(port)) {
      // Port is open; confirm the HTTP endpoint is actually responding.
      try {
        await getJson(`http://127.0.0.1:${port}/json/version`);
        return;
      } catch {
        // Port open but HTTP not ready yet — keep waiting.
      }
    }
    await new Promise((resolve) => setTimeout(resolve, delay));
    delay = Math.min(delay * 2, DEBUGGER_MAX_RETRY_DELAY_MS);
  }
  throw new Error("Chrome debug endpoint did not become ready in time");
}

async function ensurePageWebSocketUrl(cdpUrl: string): Promise<string> {
  const targets = await getJson<CdpTarget[]>(`${cdpUrl}/json/list`);
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
  if (!page?.webSocketDebuggerUrl) {
    throw new Error("No debuggable page target available");
  }
  return page.webSocketDebuggerUrl;
}

async function createTarget(cdpUrl: string, url = "about:blank"): Promise<string> {
  try {
    // Reuse the first existing page target to avoid opening an extra tab on launch.
    return await ensurePageWebSocketUrl(cdpUrl);
  } catch {
    // fall through to creating a target when no page exists yet
  }

  const endpoint = `${cdpUrl}/json/new?${encodeURIComponent(url)}`;
  const methods: Array<"PUT" | "GET"> = ["PUT", "GET"];
  for (const method of methods) {
    try {
      const response = await fetch(endpoint, { method });
      if (!response.ok) {
        continue;
      }
      const payload = (await response.json()) as CdpTarget;
      if (payload.webSocketDebuggerUrl) {
        return payload.webSocketDebuggerUrl;
      }
    } catch {
      // try next method
    }
  }
  return await ensurePageWebSocketUrl(cdpUrl);
}

/**
 * Apply stealth patches that remove common automation fingerprints.
 * These run before any page loads so sites cannot detect the bot.
 */
const STEALTH_SCRIPT = `(() => {
  // Guard: registered once per CDP session, so re-connects would re-run the patches
  // and the non-configurable defineProperty calls below would throw.
  if (window.__agenticStealthApplied) return;
  window.__agenticStealthApplied = true;

  // Remove navigator.webdriver flag
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });

  // Provide realistic plugins array (empty = headless fingerprint)
  Object.defineProperty(navigator, 'plugins', {
    get: () => {
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer', description: 'Portable Document Format' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai', description: '' },
        { name: 'Native Client', filename: 'internal-nacl-plugin', description: '' },
      ];
      plugins.length = 3;
      Object.setPrototypeOf(plugins, PluginArray.prototype);
      return plugins;
    }
  });

  // Provide realistic languages
  Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });

  // Patch chrome.runtime to look like a real Chrome
  if (!window.chrome) window.chrome = {};
  if (!window.chrome.runtime) window.chrome.runtime = { id: undefined };

  // Remove the CDP-injected sourceURL comment from Runtime.evaluate calls
  const origToString = Function.prototype.toString;
  Function.prototype.toString = function() {
    if (this === Function.prototype.toString) return 'function toString() { [native code] }';
    return origToString.call(this);
  };

  // Patch permissions query to report "prompt" instead of "denied" for notifications
  const origQuery = window.Permissions?.prototype?.query;
  if (origQuery) {
    window.Permissions.prototype.query = function(params) {
      if (params?.name === 'notifications') {
        return Promise.resolve({ state: 'prompt', onchange: null });
      }
      return origQuery.call(this, params);
    };
  }
})();`;

/**
 * Verify the page is ready, apply stealth, and optionally set a custom user-agent.
 * Returns the user-agent override that was applied (if any) so callers can re-apply
 * it on later CDP sessions — script/UA overrides are scoped to the session that set
 * them and die when this bootstrap connection closes.
 */
async function initTarget(targetWsUrl: string, userAgent?: string): Promise<string | undefined> {
  const conn = await CdpConnection.connect(targetWsUrl);
  try {
    const enables: Promise<unknown>[] = [conn.send("Page.enable"), conn.send("Runtime.enable")];
    enables.push(conn.send("Network.enable"));
    await Promise.all(enables);

    // Inject stealth patches before any page loads via Page.addScriptToEvaluateOnNewDocument
    await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_SCRIPT });

    // Also run stealth on the current (about:blank) page
    await conn.send("Runtime.evaluate", {
      expression: STEALTH_SCRIPT,
      returnByValue: true,
    });

    await conn.send("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
      awaitPromise: true,
    });
    if (userAgent) {
      await conn.send("Network.setUserAgentOverride", { userAgent });
      return userAgent;
    }
    // Remove the "HeadlessChrome" identifier from the default user-agent
    try {
      const { userAgent: currentUA } = await conn.send<{ userAgent: string }>("Browser.getVersion");
      if (currentUA?.includes("HeadlessChrome")) {
        const cleanUA = currentUA.replace(/HeadlessChrome/g, "Chrome");
        await conn.send("Network.setUserAgentOverride", { userAgent: cleanUA });
        return cleanUA;
      }
    } catch {
      // Not critical — best effort
    }
    return undefined;
  } finally {
    conn.close();
  }
}

interface FrameScope {
  /** Evaluates inside the frame (Runtime.evaluate lands in the frame's context). */
  client: CdpClient;
  /** Frame viewport origin in main-frame CSS pixels — read after in-frame scrolling. */
  getOffset(): Promise<{ x: number; y: number }>;
  release(): void;
}

/** Called on the iframe element: origin of its content box in top-level viewport coordinates. */
const FRAME_CONTENT_OFFSET_FUNCTION = `function () {
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

interface PageEvaluateResult<V> {
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
async function evaluateOnPage<V = unknown>(
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

async function getFreePort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Unable to allocate free port"));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

function resolveDefaultProfileDir(): string {
  const platform = os.platform();
  const home = os.homedir();
  if (platform === "darwin") {
    return path.join(home, "Library", "Application Support", "Google", "Chrome");
  }
  if (platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local"),
      "Google",
      "Chrome",
      "User Data",
    );
  }
  // linux and others
  return path.join(home, ".config", "google-chrome");
}

interface DialogInfo {
  type: string;
  message: string;
  defaultPrompt?: string;
}

const CONTENT_TRUNCATION_HINT =
  'Use a CSS selector to scope the content, or use mode="summary" for a lower-token overview.';

/**
 * In-page visibility check shared by element discovery and cookie dismissal.
 * Uses the element's own window so it also works inside same-origin iframes.
 */
const IN_PAGE_IS_VISIBLE = String.raw`
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

const LOCATOR_RUNTIME_HELPERS = String.raw`
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

function buildLocatorRuntimeExpression(
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

interface RuntimeContentPayload {
  content?: string;
  truncated?: boolean;
  originalLength?: number;
}

interface KeyDispatchPayload {
  key: string;
  code: string;
  windowsVirtualKeyCode: number;
  nativeVirtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
}

const SPECIAL_KEY_PAYLOADS = new Map<string, KeyDispatchPayload>([
  [
    "Enter",
    {
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
      text: "\r",
      unmodifiedText: "\r",
    },
  ],
  ["Tab", { key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 }],
  [
    "Escape",
    { key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 },
  ],
  [
    "Backspace",
    { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 },
  ],
  [
    "Delete",
    { key: "Delete", code: "Delete", windowsVirtualKeyCode: 46, nativeVirtualKeyCode: 46 },
  ],
  [
    "Space",
    {
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32,
      text: " ",
      unmodifiedText: " ",
    },
  ],
  [
    " ",
    {
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
      nativeVirtualKeyCode: 32,
      text: " ",
      unmodifiedText: " ",
    },
  ],
  [
    "ArrowUp",
    { key: "ArrowUp", code: "ArrowUp", windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 },
  ],
  [
    "ArrowDown",
    { key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 },
  ],
  [
    "ArrowLeft",
    { key: "ArrowLeft", code: "ArrowLeft", windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 },
  ],
  [
    "ArrowRight",
    { key: "ArrowRight", code: "ArrowRight", windowsVirtualKeyCode: 39, nativeVirtualKeyCode: 39 },
  ],
  ["Home", { key: "Home", code: "Home", windowsVirtualKeyCode: 36, nativeVirtualKeyCode: 36 }],
  ["End", { key: "End", code: "End", windowsVirtualKeyCode: 35, nativeVirtualKeyCode: 35 }],
  [
    "PageUp",
    { key: "PageUp", code: "PageUp", windowsVirtualKeyCode: 33, nativeVirtualKeyCode: 33 },
  ],
  [
    "PageDown",
    { key: "PageDown", code: "PageDown", windowsVirtualKeyCode: 34, nativeVirtualKeyCode: 34 },
  ],
]);

function appendTruncationNotice(content: string, limit: number, originalLength: number): string {
  return (
    content +
    `\n\n[Truncated - showing first ${limit} of ${originalLength} characters. ${CONTENT_TRUNCATION_HINT}]`
  );
}

function applyContentLimit(
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

function normalizeRuntimeContentPayload(
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

function buildKeyDispatchPayload(inputKey: string): KeyDispatchPayload {
  const key = inputKey || "Enter";
  const special = SPECIAL_KEY_PAYLOADS.get(key);
  if (special) {
    return { ...special };
  }

  if (key.length === 1) {
    const upper = key.toUpperCase();
    const code =
      key >= "a" && key <= "z"
        ? `Key${upper}`
        : key >= "A" && key <= "Z"
          ? `Key${key}`
          : key >= "0" && key <= "9"
            ? `Digit${key}`
            : "Unidentified";
    const keyCode = upper.charCodeAt(0);
    return {
      key,
      code,
      windowsVirtualKeyCode: keyCode,
      nativeVirtualKeyCode: keyCode,
      text: key,
      unmodifiedText: key,
    };
  }

  return {
    key,
    code: key,
    windowsVirtualKeyCode: 0,
    nativeVirtualKeyCode: 0,
  };
}

/** Connection pool configuration */
const CONNECTION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const CONNECTION_CLEANUP_INTERVAL_MS = 60_000; // 1 minute

/**
 * True when the error means the socket was closed/not-open — i.e. the request
 * was never delivered, so re-running it cannot double-apply a side effect.
 * Deliberately excludes CDP timeouts: a timed-out request may have reached
 * Chrome, so replaying it for a non-idempotent op could fire the action twice.
 */
export function isConnectionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("CDP connection closed") || message.includes("WebSocket not open");
}

export class ChromeCdpBrowserController implements BrowserController {
  private readonly connections = new Map<
    string,
    {
      conn: CdpClient;
      enabled: { page: boolean; runtime: boolean };
      lastUsedAt: number;
      pendingDialog?: DialogInfo;
      dialogListenerAttached?: boolean;
    }
  >();

  private readonly pendingConnections = new Map<string, Promise<CdpClient>>();

  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  /**
   * User-agent override resolved at target init, keyed by target ws URL.
   * Stealth script + UA override are scoped to the CDP session that set them,
   * so every pooled connection must re-apply them (initTarget's bootstrap
   * connection closes right after launch).
   */
  private readonly userAgentOverrides = new Map<string, string>();

  constructor(
    private readonly baseDir: string,
    private readonly connectionFactory: (
      targetWsUrl: string,
    ) => Promise<CdpClient> = CdpConnection.connect,
  ) {
    // Evict idle connections periodically
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - CONNECTION_IDLE_TIMEOUT_MS;
      for (const [url, entry] of this.connections) {
        if (entry.lastUsedAt < cutoff) {
          this.dropConnection(url);
        }
      }
    }, CONNECTION_CLEANUP_INTERVAL_MS);
    this.cleanupInterval.unref();
  }

  /** Stop the cleanup interval and close all connections. Call when disposing the controller. */
  dispose(): void {
    clearInterval(this.cleanupInterval);
    for (const url of this.connections.keys()) {
      this.dropConnection(url);
    }
  }

  private async getConnection(targetWsUrl: string): Promise<CdpClient> {
    const cached = this.connections.get(targetWsUrl);
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached.conn;
    }

    const pending = this.pendingConnections.get(targetWsUrl);
    if (pending) return pending;

    const p = (async () => {
      const conn = await this.connectionFactory(targetWsUrl);
      await this.applySessionOverrides(conn, targetWsUrl);
      this.connections.set(targetWsUrl, {
        conn,
        enabled: { page: false, runtime: false },
        lastUsedAt: Date.now(),
      });
      return conn;
    })();
    this.pendingConnections.set(targetWsUrl, p);
    try {
      return await p;
    } finally {
      this.pendingConnections.delete(targetWsUrl);
    }
  }

  /**
   * Re-apply session-scoped stealth patches + UA override on a fresh connection.
   * Overrides are per-CDP-session, so every pooled connection must re-apply them
   * — including in a fresh CLI process that reconnects to an existing target
   * (the in-memory override map is empty there, so fall back to deriving one).
   */
  private async applySessionOverrides(conn: CdpClient, targetWsUrl: string): Promise<void> {
    try {
      await conn.send("Page.addScriptToEvaluateOnNewDocument", { source: STEALTH_SCRIPT });

      let userAgent = this.userAgentOverrides.get(targetWsUrl);
      if (!userAgent) {
        // No explicit override known to this process — at least strip the
        // "HeadlessChrome" tell from the browser's own UA (determinable here).
        try {
          const { userAgent: currentUA } = await conn.send<{ userAgent: string }>(
            "Browser.getVersion",
          );
          if (currentUA?.includes("HeadlessChrome")) {
            userAgent = currentUA.replace(/HeadlessChrome/g, "Chrome");
            this.userAgentOverrides.set(targetWsUrl, userAgent);
          }
        } catch {
          // best effort
        }
      }

      if (userAgent) {
        // Emulation.setUserAgentOverride changes navigator.userAgent in the
        // renderer (Network's variant mainly rewrites request headers and isn't
        // reliably reflected in JS). Set before the page commits.
        await conn.send("Emulation.setUserAgentOverride", { userAgent });
      }
    } catch {
      // Stealth is best-effort — never block real work on it.
    }
  }

  private dropConnection(targetWsUrl: string): void {
    const cached = this.connections.get(targetWsUrl);
    if (!cached) return;
    try {
      cached.conn.close();
    } catch {
      // ignore close failures
    }
    this.connections.delete(targetWsUrl);
  }

  closeConnection(targetWsUrl: string): void {
    this.dropConnection(targetWsUrl);
  }

  async connect(
    cdpUrl: string,
    options?: { userAgent?: string },
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }> {
    const parsed = new URL(cdpUrl);
    const port = Number.parseInt(parsed.port, 10);
    if (!port) {
      throw new Error(`Invalid CDP URL: could not extract port from ${cdpUrl}`);
    }
    await waitForDebugger(port);
    const targetWsUrl = await createTarget(cdpUrl);
    const appliedUa = await initTarget(targetWsUrl, options?.userAgent);
    if (appliedUa) {
      this.userAgentOverrides.set(targetWsUrl, appliedUa);
    }
    return { pid: 0, cdpUrl, targetWsUrl };
  }

  private async ensureEnabled(targetWsUrl: string): Promise<void> {
    const cached = this.connections.get(targetWsUrl);
    if (!cached) {
      return;
    }
    const promises: Promise<unknown>[] = [];
    if (!cached.enabled.page) {
      promises.push(
        cached.conn.send("Page.enable").then(() => {
          cached.enabled.page = true;
        }),
      );
    }
    if (!cached.enabled.runtime) {
      promises.push(
        cached.conn.send("Runtime.enable").then(() => {
          cached.enabled.runtime = true;
        }),
      );
    }
    if (promises.length) await Promise.all(promises);

    // Set up persistent dialog listener (once per connection)
    if (!cached.dialogListenerAttached && cached.conn.onEvent) {
      cached.conn.onEvent<{
        type: string;
        message: string;
        defaultPrompt?: string;
      }>("Page.javascriptDialogOpening", (params) => {
        cached.pendingDialog = {
          type: params.type,
          message: params.message,
          defaultPrompt: params.defaultPrompt,
        };
        // Auto-accept alert dialogs (they only have OK, blocking is never useful)
        if (params.type === "alert") {
          cached.conn.send("Page.handleJavaScriptDialog", { accept: true }).catch(() => {});
          cached.pendingDialog = undefined;
        }
      });
      cached.dialogListenerAttached = true;
    }
  }

  async launch(
    sessionId: string,
    options?: LaunchOptions,
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }> {
    const { executablePath: explicitPath, userProfileDir, headless, userAgent } = options ?? {};
    const executablePath = discoverChrome(explicitPath);
    let profileDir: string;
    if (userProfileDir === "default") {
      profileDir = resolveDefaultProfileDir();
    } else if (userProfileDir) {
      profileDir = userProfileDir;
    } else {
      profileDir = path.join(this.baseDir, "profiles", sessionId);
    }
    if (userProfileDir) {
      fs.mkdirSync(profileDir, { recursive: true });
    } else {
      ensurePrivateDir(profileDir);
    }

    // Chrome locks its profile with a "SingletonLock" file. If present, another
    // Chrome instance owns this profile and a new launch will silently fail.
    const lockFile = path.join(profileDir, "SingletonLock");
    const lock = isProfileLocked(profileDir);
    if (lock.locked) {
      throw new Error(
        `Chrome profile is already in use (lock file exists: ${lockFile}${lock.pid ? `, pid ${lock.pid}` : ""}). ` +
          "Quit the running Chrome instance first, or use --cdp-url to connect to it instead.",
      );
    }

    const launchAttempts: Array<{ headless: boolean }> = headless
      ? [{ headless: true }]
      : [{ headless: false }, { headless: true }];

    let lastError: Error | undefined;

    for (const attempt of launchAttempts) {
      const port = await getFreePort();
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        // Anti-detection: remove "Chrome is being controlled by automated software" infobar
        // and disable the AutomationControlled Blink feature that sets navigator.webdriver
        "--disable-blink-features=AutomationControlled",
        "--disable-infobars",
        "--excludeSwitches=enable-automation",
      ];

      if (attempt.headless) {
        args.push("--headless=new");
      }

      args.push("about:blank");

      const child = spawn(executablePath, args, {
        detached: true,
        stdio: "ignore",
      });
      child.unref();

      try {
        await waitForDebugger(port);
        const cdpUrl = `http://127.0.0.1:${port}`;
        const targetWsUrl = await createTarget(cdpUrl, "about:blank");
        if (!child.pid) {
          throw new Error("Failed to launch Chrome process");
        }
        const appliedUa = await initTarget(targetWsUrl, userAgent);
        if (appliedUa) {
          this.userAgentOverrides.set(targetWsUrl, appliedUa);
        }
        return { pid: child.pid, cdpUrl, targetWsUrl };
      } catch (error) {
        lastError = error as Error;
        if (child.pid) {
          try {
            process.kill(child.pid, "SIGTERM");
          } catch {
            // ignore failed cleanup
          }
        }
      }
    }

    throw new Error(lastError?.message ?? "Unable to launch Chrome");
  }

  /**
   * Execute fn with a pooled connection; on failure drop the connection and retry once.
   *
   * `retryOn`:
   *  - "any" (default): retry any error — safe for reads/idempotent work.
   *  - "connection": retry only when the connection itself died. Use for
   *    non-idempotent input (click/type/press/toggle/select): a mid-operation
   *    connection drop after an event was already dispatched must not replay it,
   *    and in-page errors (selector missing, covered element) are not transient.
   */
  private async withRetry<T>(
    targetWsUrl: string,
    fn: (conn: CdpClient) => Promise<T>,
    retryOn: "any" | "connection" = "any",
  ): Promise<T> {
    let conn = await this.getConnection(targetWsUrl);
    try {
      return await fn(conn);
    } catch (error) {
      if (retryOn === "connection" && !isConnectionError(error)) {
        throw error;
      }
      this.dropConnection(targetWsUrl);
      conn = await this.getConnection(targetWsUrl);
      return await fn(conn);
    }
  }

  /**
   * Split a composed locator at the first iframe whose document the page
   * cannot reach (cross-origin). Returns null when no such boundary exists.
   */
  private async splitAtCrossOriginFrame(
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
  private async resolveFrameTarget(
    conn: CdpClient,
    payload: InteractPayload,
  ): Promise<{ frame?: string; payload: InteractPayload }> {
    if (payload.frame) return { frame: payload.frame, payload };
    if (!payload.selector) return { payload };
    const split = await this.splitAtCrossOriginFrame(conn, payload.selector);
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
  private async openFrameScope(
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
          frameConn = await this.connectionFactory(frameWsUrl);
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

  /** Run `fn` against the frame a payload targets (the page itself when none). */
  private async withFrameScope<T>(
    conn: CdpClient,
    targetWsUrl: string,
    payload: InteractPayload,
    fn: (
      client: CdpClient,
      scoped: InteractPayload,
      getOffset: () => Promise<{ x: number; y: number }>,
    ) => Promise<T>,
  ): Promise<T> {
    const target = await this.resolveFrameTarget(conn, payload);
    if (!target.frame) {
      return await fn(conn, payload, async () => ({ x: 0, y: 0 }));
    }
    const scope = await this.openFrameScope(conn, targetWsUrl, target.frame);
    try {
      return await fn(scope.client, { ...target.payload, frame: undefined }, scope.getOffset);
    } finally {
      scope.release();
    }
  }

  async navigate(targetWsUrl: string, url: string): Promise<string> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);

      // Only trust events for the main frame (no parentId) — a late subframe
      // navigation from the previous page (ad/analytics iframe) must not be
      // mistaken for the final URL or the load-complete signal.
      const mainFrameNavigated = conn.waitForEventMatching
        ? conn
            .waitForEventMatching<{ frame?: { url?: string; parentId?: string } }>(
              "Page.frameNavigated",
              (params) => !params.frame?.parentId,
              6000,
            )
            .catch(() => undefined)
        : conn
            .waitForEvent<{ frame?: { url?: string } }>("Page.frameNavigated", 6000)
            .catch(() => undefined);

      const navResult = await conn.send<{ errorText?: string; frameId?: string }>("Page.navigate", {
        url,
      });
      if (navResult.errorText) {
        throw new Error(`Navigation failed: ${navResult.errorText}`);
      }

      const mainFrameId = navResult.frameId;
      const loadPromise = Promise.race([
        conn.waitForEvent("Page.loadEventFired", 6000),
        conn.waitForEventMatching
          ? conn.waitForEventMatching<{ frameId?: string }>(
              "Page.frameStoppedLoading",
              (params) => !mainFrameId || params.frameId === mainFrameId,
              6000,
            )
          : conn.waitForEvent("Page.frameStoppedLoading", 6000),
      ]);

      const navigatedEvent = await mainFrameNavigated;
      try {
        await loadPromise;
      } catch {
        // page may still be usable
      }

      return navigatedEvent?.frame?.url ?? url;
    });
  }

  private async handleDialogAction(targetWsUrl: string, payload: InteractPayload): Promise<string> {
    const DIALOG_WAIT_TIMEOUT_MS = 500;
    const DIALOG_POLL_INTERVAL_MS = 10;
    const MAX_POLL_ATTEMPTS = 10;

    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const cached = this.connections.get(targetWsUrl);

      // If no pending dialog, wait for one with polling to avoid race conditions
      if (!cached?.pendingDialog) {
        try {
          await conn.waitForEvent("Page.javascriptDialogOpening", DIALOG_WAIT_TIMEOUT_MS);
          // Poll for pendingDialog to be populated by the event listener
          for (let attempt = 0; attempt < MAX_POLL_ATTEMPTS; attempt++) {
            if (cached?.pendingDialog) break;
            await new Promise((r) => setTimeout(r, DIALOG_POLL_INTERVAL_MS));
          }
        } catch {
          return "no dialog present";
        }
      }

      const dialog = cached?.pendingDialog;
      if (!dialog) {
        return "no dialog present";
      }

      const dismiss = payload.text === "dismiss";
      await conn.send("Page.handleJavaScriptDialog", {
        accept: !dismiss,
        promptText: payload.value,
      });

      const result = dismiss ? `dismissed ${dialog.type}` : `accepted ${dialog.type}`;
      if (cached) cached.pendingDialog = undefined;
      return `${result}: ${dialog.message}`;
    });
  }

  private async preparePointerTarget(
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

  private async prepareTypeTarget(
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
  private async armMainFrameNavigationWait(
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
      const tree = await conn.send<{ frameTree?: { frame?: { id?: string } } }>(
        "Page.getFrameTree",
      );
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

  private async dispatchMouseClick(conn: CdpClient, x: number, y: number): Promise<void> {
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

  private async focusTarget(conn: CdpClient, payload: InteractPayload): Promise<void> {
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

  private async dispatchKeyPress(conn: CdpClient, keyInput?: string): Promise<void> {
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

  async interact(targetWsUrl: string, payload: InteractPayload): Promise<string> {
    // Navigation actions — handled at CDP level, no in-page JS needed
    if (payload.action === "goBack") {
      return await this.withRetry(targetWsUrl, async (conn) => {
        await this.ensureEnabled(targetWsUrl);
        const navigatedPromise = (
          conn.waitForEventMatching
            ? conn.waitForEventMatching<{ frame?: { url?: string; parentId?: string } }>(
                "Page.frameNavigated",
                (params) => !params.frame?.parentId,
                3000,
              )
            : conn.waitForEvent<{ frame?: { url?: string } }>("Page.frameNavigated", 3000)
        ).catch(() => undefined);
        await evaluateOnPage(conn, {
          expression: "history.back()",
          returnByValue: true,
        });
        const event = await navigatedPromise;
        if (!event) return "no history to go back";
        // Wait for load
        try {
          await Promise.race([
            conn.waitForEvent("Page.loadEventFired", 5000),
            conn.waitForEvent("Page.frameStoppedLoading", 5000),
          ]);
        } catch {
          // page may still be usable
        }
        return `navigated back to ${event.frame?.url ?? "previous page"}`;
      });
    }

    if (payload.action === "goForward") {
      return await this.withRetry(targetWsUrl, async (conn) => {
        await this.ensureEnabled(targetWsUrl);
        const navigatedPromise = (
          conn.waitForEventMatching
            ? conn.waitForEventMatching<{ frame?: { url?: string; parentId?: string } }>(
                "Page.frameNavigated",
                (params) => !params.frame?.parentId,
                3000,
              )
            : conn.waitForEvent<{ frame?: { url?: string } }>("Page.frameNavigated", 3000)
        ).catch(() => undefined);
        await evaluateOnPage(conn, {
          expression: "history.forward()",
          returnByValue: true,
        });
        const event = await navigatedPromise;
        if (!event) return "no history to go forward";
        try {
          await Promise.race([
            conn.waitForEvent("Page.loadEventFired", 5000),
            conn.waitForEvent("Page.frameStoppedLoading", 5000),
          ]);
        } catch {
          // page may still be usable
        }
        return `navigated forward to ${event.frame?.url ?? "next page"}`;
      });
    }

    if (payload.action === "refresh") {
      return await this.withRetry(targetWsUrl, async (conn) => {
        await this.ensureEnabled(targetWsUrl);
        await conn.send("Page.reload");
        try {
          await Promise.race([
            conn.waitForEvent("Page.loadEventFired", 10000),
            conn.waitForEvent("Page.frameStoppedLoading", 10000),
          ]);
        } catch {
          // page may still be usable
        }
        return "page refreshed";
      });
    }

    if (payload.action === "dialog") {
      return await this.handleDialogAction(targetWsUrl, payload);
    }

    if (
      payload.action === "click" ||
      payload.action === "hover" ||
      payload.action === "type" ||
      payload.action === "press"
    ) {
      // Non-idempotent input: retry only when the socket was closed (request
      // never delivered) so a mid-flight drop can't dispatch the event twice.
      return await this.withRetry(
        targetWsUrl,
        async (conn) => {
          await this.ensureEnabled(targetWsUrl);
          // Evaluation runs in the target frame; input events always go to the
          // page connection (Chrome routes them into out-of-process frames).
          return await this.withFrameScope(
            conn,
            targetWsUrl,
            payload,
            async (client, scoped, getOffset) => {
              if (scoped.action === "click") {
                const local = await this.preparePointerTarget(client, scoped);
                const offset = await getOffset();
                const nav = await this.armMainFrameNavigationWait(conn);
                await this.dispatchMouseClick(conn, local.x + offset.x, local.y + offset.y);
                await nav.result;

                return "clicked";
              }

              if (scoped.action === "hover") {
                const local = await this.preparePointerTarget(client, scoped);
                const offset = await getOffset();
                await conn.send("Input.dispatchMouseEvent", {
                  type: "mouseMoved",
                  x: local.x + offset.x,
                  y: local.y + offset.y,
                  button: "none",
                });
                return "hovered";
              }

              if (scoped.action === "press") {
                await this.focusTarget(client, scoped);
                await this.dispatchKeyPress(conn, scoped.key);
                return "pressed";
              }

              const preparation = await this.prepareTypeTarget(client, scoped);
              if (preparation === "ready") {
                await conn.send("Input.insertText", { text: scoped.text ?? "" });
              }
              return "typed";
            },
          );
        },
        "connection",
      );
    }

    const buildExpression = (scoped: InteractPayload) =>
      buildLocatorRuntimeExpression(
        "payload",
        scoped,
        `
      if (payload.action === 'waitFor') {
        const timeout = payload.timeoutMs ?? 2000;
        const started = Date.now();
        while (Date.now() - started < timeout) {
          if (resolveLocator(payload.selector)) {
            return 'found';
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error('waitFor timeout');
      }
      if (payload.action === 'evaluate') {
        const fn = new Function('return (' + (payload.text ?? '') + ')');
        let result = fn();
        if (result && typeof result === 'object' && typeof result.then === 'function') {
          result = await result;
        }
        return result === undefined ? 'undefined' : JSON.stringify(result);
      }
      if (payload.action === 'scroll') {
        if (payload.selector) {
          const el = resolveWithFallbacks(payload.selector, payload.fallbackSelectors).element;
          el.scrollBy({ left: payload.scrollX ?? 0, top: payload.scrollY ?? 0 });
          return 'scrolled element';
        }
        window.scrollBy({ left: payload.scrollX ?? 0, top: payload.scrollY ?? 0 });
        return 'scrolled page';
      }
      if (payload.action === 'select') {
        const el = resolveWithFallbacks(payload.selector, payload.fallbackSelectors).element;
        if (el.tagName.toLowerCase() !== 'select') throw new Error('Element is not a <select>');
        el.value = payload.value ?? '';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'selected ' + el.value;
      }
      if (payload.action === 'toggle') {
        const el = resolveWithFallbacks(payload.selector, payload.fallbackSelectors).element;
        el.click();
        const checked = el.checked !== undefined ? el.checked : el.getAttribute('aria-checked') === 'true';
        return 'toggled to ' + (checked ? 'checked' : 'unchecked');
      }
      throw new Error('Unsupported interact action');
`,
      );

    // scroll/select/toggle mutate the page; retry only on a closed socket so a
    // mid-flight drop can't re-apply the mutation.
    return await this.withRetry(
      targetWsUrl,
      async (conn) => {
        await this.ensureEnabled(targetWsUrl);
        return await this.withFrameScope(conn, targetWsUrl, payload, async (client, scoped) => {
          // Evaluate the caller's code as its own script: new Function() inside the
          // locator runtime would be blocked by pages whose CSP forbids unsafe-eval.
          const expression =
            scoped.action === "evaluate"
              ? `(async () => {
  const __agenticResult = await (${scoped.text ?? "undefined"}
  );
  // Always JSON-encode so strings like "42" or "" survive the round trip as strings.
  return __agenticResult === undefined ? 'undefined' : JSON.stringify(__agenticResult);
})()`
              : buildExpression(scoped);
          const result = await evaluateOnPage<string>(client, {
            expression,
            returnByValue: true,
            awaitPromise: true,
          });
          return result.result.value ?? "";
        });
      },
      "connection",
    );
  }

  async screenshot(targetWsUrl: string, options?: ScreenshotOptions): Promise<ScreenshotResult> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const format = options?.format ?? "jpeg";
      const params: Record<string, unknown> = {
        format,
        quality: format === "jpeg" ? (options?.quality ?? 60) : undefined,
      };
      if (options?.fullPage) {
        const metrics = await conn.send<{
          contentSize: { width: number; height: number };
        }>("Page.getLayoutMetrics");
        params.clip = {
          x: 0,
          y: 0,
          width: metrics.contentSize.width,
          height: metrics.contentSize.height,
          scale: 1,
        };
        // Without this, Chrome only renders the visible viewport into the clip.
        params.captureBeyondViewport = true;
      }
      const result = await conn.send<{ data: string }>("Page.captureScreenshot", params);
      return {
        data: result.data,
        mimeType: format === "png" ? "image/png" : "image/jpeg",
      };
    });
  }

  async getCurrentUrl(targetWsUrl: string): Promise<string> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      const result = await evaluateOnPage<string>(conn, {
        expression: "window.location.href",
        returnByValue: true,
      });
      return result.result.value ?? "";
    });
  }

  async getPageState(targetWsUrl: string): Promise<PageState> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      const result = await evaluateOnPage<PageState>(conn, {
        expression:
          "({ url: location.href, title: document.title, readyState: document.readyState })",
        returnByValue: true,
      });
      return result.result.value ?? { url: "", title: "", readyState: "loading" };
    });
  }

  async listTabs(cdpUrl: string): Promise<TabInfo[]> {
    const targets = await getJson<CdpTarget[]>(`${cdpUrl}/json/list`);
    return targets
      .filter((target) => target.type === "page" && target.webSocketDebuggerUrl)
      .map((target) => ({
        id: target.id,
        url: target.url ?? "",
        title: target.title ?? "",
        targetWsUrl: target.webSocketDebuggerUrl!,
      }));
  }

  async openTab(cdpUrl: string): Promise<TabInfo> {
    const endpoint = `${cdpUrl}/json/new?${encodeURIComponent("about:blank")}`;
    let created: CdpTarget | undefined;
    // Newer Chrome requires PUT; older builds only accept GET.
    for (const method of ["PUT", "GET"] as const) {
      try {
        const response = await fetch(endpoint, { method, signal: AbortSignal.timeout(5000) });
        if (!response.ok) continue;
        created = (await response.json()) as CdpTarget;
        if (created.webSocketDebuggerUrl) break;
      } catch {
        // try next method
      }
    }
    if (!created?.webSocketDebuggerUrl) {
      throw new Error(`Unable to open a new tab via ${cdpUrl}/json/new`);
    }
    const targetWsUrl = created.webSocketDebuggerUrl;
    // Carry the session's user-agent override over to the new tab.
    const host = new URL(cdpUrl).host;
    let userAgent: string | undefined;
    for (const [wsUrl, ua] of this.userAgentOverrides) {
      if (new URL(wsUrl).host === host) {
        userAgent = ua;
        break;
      }
    }
    const appliedUa = await initTarget(targetWsUrl, userAgent);
    if (appliedUa) this.userAgentOverrides.set(targetWsUrl, appliedUa);
    return {
      id: created.id,
      url: created.url ?? "about:blank",
      title: created.title ?? "",
      targetWsUrl,
    };
  }

  async activateTab(cdpUrl: string, tabId: string): Promise<void> {
    const response = await fetch(`${cdpUrl}/json/activate/${encodeURIComponent(tabId)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Tab not found: ${tabId}`);
  }

  async closeTab(cdpUrl: string, tabId: string): Promise<void> {
    const tab = (await this.listTabs(cdpUrl)).find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`Tab not found: ${tabId}`);
    this.dropConnection(tab.targetWsUrl);
    this.userAgentOverrides.delete(tab.targetWsUrl);
    const response = await fetch(`${cdpUrl}/json/close/${encodeURIComponent(tabId)}`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Unable to close tab ${tabId}: HTTP ${response.status}`);
  }

  async getContent(targetWsUrl: string, options: PageContentOptions): Promise<PageContentResult> {
    if (options.mode === "summary") {
      return await this.getSummaryContent(targetWsUrl, options);
    }

    if (options.mode === "a11y") {
      const content = await this.getAccessibilityTree(targetWsUrl, options.selector);
      const limited = normalizeRuntimeContentPayload(content, options.maxChars);
      return {
        mode: "a11y",
        content: limited.content,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
      };
    }

    const expression = buildLocatorRuntimeExpression(
      "options",
      options,
      `
      const limit =
        typeof options.maxChars === 'number' && Number.isFinite(options.maxChars) && options.maxChars > 0
          ? Math.floor(options.maxChars)
          : null;

      function serializeContent(content) {
        const normalized = typeof content === 'string' ? content : String(content ?? '');
        const originalLength = normalized.length;
        if (limit !== null && originalLength > limit) {
          return { content: normalized.slice(0, limit), truncated: true, originalLength };
        }
        return { content: normalized, truncated: false, originalLength };
      }

      if (options.mode === 'title') return serializeContent(document.title ?? '');
      if (options.mode === 'html') {
        if (options.selector) {
          const el = resolveLocator(options.selector);
          return serializeContent(el ? el.outerHTML : '');
        }
        return serializeContent(document.documentElement?.outerHTML ?? '');
      }
      if (options.selector) {
        const el = resolveLocator(options.selector);
        return serializeContent(el ? el.innerText ?? '' : '');
      }
      return serializeContent(document.body?.innerText ?? '');
`,
    );

    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const result = await evaluateOnPage<RuntimeContentPayload>(conn, {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      const limited = normalizeRuntimeContentPayload(result.result.value, options.maxChars);
      return {
        mode: options.mode,
        content: limited.content,
        truncated: limited.truncated,
        originalLength: limited.originalLength,
      };
    });
  }

  private summarizeInteractiveElements(result: InteractiveElementsResult): {
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

  private async getSummaryContent(
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

    const pageSummary = await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const result = await evaluateOnPage<Record<string, unknown>>(conn, {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result.result.value ?? {};
    });
    const elements = await this.getInteractiveElements(targetWsUrl, {
      selector: options.selector,
      visibleOnly: true,
      limit: 24,
    });
    const elementSummary = this.summarizeInteractiveElements(elements);

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

  private formatAccessibilityTree(nodes: AccessibilityNode[]): string {
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

  private async getAccessibilityTree(targetWsUrl: string, selector?: string): Promise<string> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
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

      return this.formatAccessibilityTree(nodes);
    });
  }

  async getInteractiveElements(
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
          const selector = tryUniqueSelector(root, tag + '[name="' + escapeAttr(name) + '"]');
          if (selector) return selector;
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

      function getText(el) {
        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) return ariaLabel.slice(0, 80);

        const tag = el.tagName.toLowerCase();
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
      function rankElement(el, visible) {
        if (!visible) return 3;
        const flags = regionFlags(el);
        if (flags & FOOTER) return 2;
        if (flags & MAIN) return 0;
        if (flags & CHROME) return 2;
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

    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
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

      const scope = await this.openFrameScope(conn, targetWsUrl, options.frame);
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

  /**
   * Best-effort cookie/consent banner dismissal.
   *
   * Strategy (in order):
   * 1. A11y tree scan — find buttons with consent-like accessible names
   * 2. CSS selector scan — check common consent framework IDs/classes
   * 3. Text-based scan — find visible buttons matching accept/agree patterns
   *
   * Returns silently on failure — never blocks navigation.
   */
  async dismissCookieBanner(targetWsUrl: string): Promise<DismissCookieBannerResult> {
    // Why each strategy failed — reported when nothing could be dismissed.
    const notes = new Set<string>();
    // Try up to 2 rounds — consent banners often load asynchronously.
    for (let attempt = 0; attempt < 2; attempt++) {
      // Strategy 1: Cheap DOM scan first for fast-path common consent banners.
      try {
        const domResult = await this.dismissViaDom(targetWsUrl);
        if (domResult.dismissed) return domResult;
      } catch (error) {
        notes.add(`dom: ${(error as Error).message}`);
      }

      // Strategy 2: Iframe-based consent banners (Sourcepoint, etc.), incl. cross-origin ones
      try {
        const iframeResult = await this.dismissViaIframe(targetWsUrl);
        if (iframeResult.dismissed) return iframeResult;
        if (iframeResult.detail) notes.add(iframeResult.detail);
      } catch (error) {
        notes.add(`iframe: ${(error as Error).message}`);
      }

      // Strategy 3: Use the accessibility tree when DOM heuristics miss.
      try {
        const a11yResult = await this.dismissViaA11y(targetWsUrl);
        if (a11yResult.dismissed) return a11yResult;
      } catch (error) {
        notes.add(`a11y: ${(error as Error).message}`);
      }

      // Wait 800ms before retrying to let async banners load
      if (attempt === 0) {
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }

    return {
      dismissed: false,
      detail: notes.size
        ? [...notes].join("; ")
        : "no consent banner found on the page, in consent iframes or the a11y tree (it may already be dismissed)",
    };
  }

  private async dismissViaDom(targetWsUrl: string): Promise<DismissCookieBannerResult> {
    const expression = `(() => {
${IN_PAGE_IS_VISIBLE}

      // Comprehensive CMP selectors (ordered by specificity/popularity)
      const selectors = [
        // OneTrust
        '#onetrust-accept-btn-handler',
        // Cookiebot
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#CybotCookiebotDialogBodyButtonAccept',
        // Usercentrics
        '#uc-btn-accept-banner',
        '[data-testid="uc-accept-all-button"]',
        '.uc-btn-accept',
        // Didomi
        '#didomi-notice-agree-button',
        '.didomi-button[data-action="accept"]',
        '.didomi-components-button--color.didomi-button-highlight',
        // Quantcast / GDPR
        '.qc-cmp2-summary-buttons button[mode="primary"]',
        '.qc-cmp-button[data-action="accept"]',
        '#qc-cmp2-ui button.css-1litn2c',
        // TrustArc / TrueVault
        '#truste-consent-button',
        '.trustarc-agree-btn',
        '#consent_agree',
        // Consentmanager (zeit.de, etc.)
        '#cmpbox .cmpboxbtn.cmpboxbtnyes',
        '#cmpwelcomebtnyes a',
        '#cmpbntyestxt',
        '.cmpboxbtnyes',
        'a.cmpboxbtn.cmpboxbtnyes',
        // iubenda
        '.iubenda-cs-accept-btn',
        '#iubenda-cs-banner .iubenda-cs-accept-btn',
        // Klaro
        '.klaro .cm-btn-accept',
        '.klaro .cm-btn-success',
        // Osano
        '.osano-cm-accept-all',
        '.osano-cm-button--type_accept',
        // CookieYes / GDPR Cookie Consent
        '#cookie_action_close_header',
        '.cky-btn-accept',
        '[data-cky-tag="accept-button"]',
        // Termly
        '.t-acceptAllButton',
        '#termly-code-snippet-support .t-acceptAllButton',
        // Axeptio
        '#axeptio_btn_acceptAll',
        '[data-axeptio="accept"]',
        // Complianz / Really Simple Cookie Consent
        '.cmplz-accept',
        '#cmplz-cookiebanner-container .cmplz-accept',
        // CookieFirst
        '[data-cookiefirst-action="accept"]',
        // Cookie Notice / Cookie Law Info
        '#cookie_action_close_header_reject',
        '#cn-accept-cookie',
        // Borlabs Cookie (WordPress)
        '#CookieBoxSaveButton',
        'a[data-cookie-accept]',
        // Piwik PRO
        '#PiwikPROConsentForm-agree-to-all',
        '.PiwikPROConsentForm-agree-to-all-button',
        // Civic Cookie Control
        '#ccc-recommended-settings',
        '#ccc-dismiss-button',
        '.ccc-accept-settings',
        // Moove GDPR (WordPress)
        '.moove-gdpr-infobar-allow-all',
        '#moove_gdpr_cookie_modal .moove-gdpr-modal-allow-all',
        // CookieHub
        '.cookiehub-accept',
        '#cookiehub-accept-btn',
        '.ch2-btn-primary',
        // Cookie Script
        '#cookiescript_accept',
        '#cookiescript_injected .cookiescript_accept',
        // HubSpot Cookie Banner
        '#hs-eu-confirmation-button',
        '#hs-eu-cookie-confirmation .hs-eu-cta',
        // MediaVine
        '[data-name="mediavine-gdpr-cmp"] .pur-accept',
        // Sirdata
        '#sd-cmp .sd-cmp-JEaB',
        // Google Consent Mode / Funding Choices
        '.fc-cta-consent',
        '.fc-button-background[aria-label="Consent"]',
        // Generic selectors
        '#accept-cookies', '#acceptCookies',
        '#cookie-accept', '#cookieAccept',
        '#gdpr-accept', '#consent-accept',
        '#cookies-accept-all', '#accept-all-cookies',
        '.cc-accept', '.cc-btn.cc-dismiss',
        '.cookie-consent-accept', '.cookie-accept-btn',
        '.js-cookie-accept', '.js-accept-cookies',
        '.consent-accept', '.consent-btn-accept',
        '.gdpr-accept',
        '[data-testid="cookie-accept"]',
        '[data-action="accept-cookies"]',
        '[data-gdpr="accept"]',
        '[data-consent="accept"]',
      ];

      // Query selector in main DOM and open shadow roots
      function deepQuery(sel) {
        const el = document.querySelector(sel);
        if (el) return el;
        for (const host of document.querySelectorAll('*')) {
          if (host.shadowRoot) {
            const inner = host.shadowRoot.querySelector(sel);
            if (inner) return inner;
          }
        }
        return null;
      }

      for (const sel of selectors) {
        try {
          const el = deepQuery(sel);
          if (el && isVisible(el)) {
            el.click();
            return JSON.stringify({ dismissed: true, method: 'selector', detail: sel });
          }
        } catch { /* invalid selector — skip */ }
      }

      // Text-based fallback: find visible buttons with consent text
      // Patterns are intentionally loose — they use .* instead of strict ^/$ anchors
      const patterns = [
        // English
        /accept\\s*(all)?\\s*(cookies)?/i,
        /allow\\s*(all)?\\s*(cookies)?/i,
        /(i\\s+)?agree(\\s+to\\s+all)?/i,
        /got\\s*it/i,
        /^ok$/i,
        /^consent$/i,
        /continue\\s+without\\s+accepting/i,
        // German
        /(alle\\s+)?akzeptieren/i,
        /alle\\s+cookies\\s+akzeptieren/i,
        /(alle\\s+)?zustimmen/i,
        /einwilligen/i,
        /einverstanden/i,
        /alles\\s+erlauben/i,
        /alles\\s+akzeptieren/i,
        /geht\\s+klar/i,
        /verstanden/i,
        // French
        /(j')?accepte(r)?(\\s+tout)?/i,
        /(tout\\s+)?accepter/i,
        /autoriser/i,
        // Spanish
        /aceptar(\\s+todo)?/i,
        /aceptar\\s+cookies/i,
        // Italian
        /accett(a|o)(\\s+tutt[oi])?/i,
        /accetta\\s+cookies/i,
        // Dutch
        /(alle\\s+)?accepteren/i,
        /alles\\s+accepteren/i,
        // Portuguese
        /aceitar(\\s+tudo)?/i,
        /aceitar\\s+cookies/i,
        // Polish
        /akceptuj(\\s+wszystk[oi]e)?/i,
        /zgadzam\\s+si/i,
        // Swedish
        /acceptera(\\s+alla)?/i,
        // Danish
        /accepter(\\s+alle)?/i,
        // Norwegian
        /aksepter(\\s+alle)?/i,
      ];
      // Collect candidates from main DOM and open shadow roots
      function collectButtons(root) {
        const results = [];
        for (const tag of ['button', 'a[role="button"]', '[role="button"]', 'div[role="button"]', 'span[role="button"]']) {
          results.push(...root.querySelectorAll(tag));
        }
        // Traverse open shadow roots for CMPs that use web components
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) {
            results.push(...collectButtons(el.shadowRoot));
          }
        }
        return results;
      }
      // Only click buttons that live inside something that looks like a consent
      // banner: a dialog/modal, an element with consent-ish id/class, or a
      // fixed/sticky overlay — AND whose container text actually talks about
      // cookies/consent. Without this the loose text patterns above would click
      // arbitrary page buttons ("Accept invitation", "I agree" form submits).
      const containerTextPattern = /cookie|consent|privacy|gdpr|datenschutz|einwillig|zustimm|tracking|personal data|persönliche daten|données personnelles|datos personales/i;
      function findBannerContainer(el) {
        let node = el;
        let depth = 0;
        while (node && node.nodeType === 1 && depth < 20) {
          const role = (node.getAttribute('role') || '').toLowerCase();
          if (role === 'dialog' || role === 'alertdialog') return node;
          if (node.getAttribute('aria-modal') === 'true') return node;
          const idClass = (node.id + ' ' + (typeof node.className === 'string' ? node.className : '')).toLowerCase();
          if (/cookie|consent|gdpr|cmp|privacy|datenschutz/.test(idClass)) return node;
          const style = getComputedStyle(node);
          if (style.position === 'fixed' || style.position === 'sticky') return node;
          node = node.parentElement || (node.getRootNode && node.getRootNode().host) || null;
          depth++;
        }
        return null;
      }
      const candidates = collectButtons(document);
      for (const el of candidates) {
        if (!isVisible(el)) continue;
        const text = (el.textContent || '').trim();
        if (text.length > 60) continue;
        for (const pat of patterns) {
          if (pat.test(text)) {
            const container = findBannerContainer(el);
            if (!container) break;
            const containerText = (container.textContent || '').slice(0, 4000);
            if (!containerTextPattern.test(containerText)) break;
            el.click();
            return JSON.stringify({ dismissed: true, method: 'text', detail: text });
          }
        }
      }

      return JSON.stringify({ dismissed: false });
    })()`;

    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const result = await evaluateOnPage<string>(conn, {
        expression,
        returnByValue: true,
      });
      const raw = result.result.value ?? '{"dismissed":false}';
      try {
        return JSON.parse(raw) as DismissCookieBannerResult;
      } catch {
        return { dismissed: false };
      }
    });
  }

  /**
   * Handle iframe-based consent banners (Sourcepoint, some OneTrust configurations, etc.)
   * These banners render inside an iframe that needs to be accessed separately.
   */
  private async dismissViaIframe(targetWsUrl: string): Promise<DismissCookieBannerResult> {
    // Clicks the accept button of the document it runs in; shared by both paths below.
    const innerSearch = `function (doc) {
      const innerSelectors = [
        // Sourcepoint specific
        'button.sp_choice_type_11',              // Accept all
        'button.sp_choice_type_ACCEPT_ALL',      // Accept all variant
        'button.sp_choice_type_SAVE_AND_EXIT',   // Save & exit
        '.priv-save-btn',                        // Sourcepoint frame
        '.message-button',                       // Generic Sourcepoint
        // Title-based
        'button[title*="Accept"]', 'button[title*="accept"]',
        'button[title*="Agree"]', 'button[title*="agree"]',
        'button[title*="Allow"]',
        'button[title*="Akzeptieren"]', 'button[title*="akzeptieren"]',
        'button[title*="Zustimmen"]',
      ];
      for (const innerSel of innerSelectors) {
        const btn = doc.querySelector(innerSel);
        if (btn && btn.offsetWidth > 0) {
          btn.click();
          return { method: 'iframe', detail: innerSel };
        }
      }
      // Text-based fallback inside the iframe
      const buttons = doc.querySelectorAll('button, [role="button"]');
      for (const btn of buttons) {
        const text = (btn.textContent || '').trim();
        if (text.length > 60) continue;
        if (/accept|agree|allow|akzeptieren|zustimmen|einwilligen|accepter|aceptar/i.test(text)) {
          btn.click();
          return { method: 'iframe-text', detail: text };
        }
      }
      return null;
    }`;

    const expression = `(() => {
      const clickAccept = ${innerSearch};
      // Known consent iframe selectors
      const iframeSelectors = [
        'iframe[id^="sp_message_iframe"]',              // Sourcepoint (dynamic ID suffix)
        '#sp_message_iframe',                        // Sourcepoint (static ID)
        'iframe[id*="sp_message"]',                  // Sourcepoint variants
        'div[id^="sp_message_container"] iframe',    // Sourcepoint container with iframe
        'iframe[title*="cookie"]',                   // Generic cookie iframes
        'iframe[title*="consent"]',                  // Generic consent iframes
        'iframe[title*="Cookie"]',
        'iframe[title*="Consent"]',
        'iframe[title*="Privacy"]',
        'iframe[title*="privacy"]',
        'iframe[title*="GDPR"]',
        'iframe[src*="consent"]',
        'iframe[src*="cookie"]',
        'iframe[src*="privacy"]',
        'iframe[src*="sourcepoint"]',
        'iframe[src*="consentmanager"]',
      ];

      // Consent prompts overlay the page: the frame or a close ancestor is
      // fixed/sticky or stacked high. In-flow frames (ads, embeds) are skipped.
      function isOverlay(iframe) {
        let el = iframe;
        for (let depth = 0; el && el !== document.body && depth < 10; depth++) {
          const style = getComputedStyle(el);
          if (style.position === 'fixed' || style.position === 'sticky') return true;
          if ((parseInt(style.zIndex, 10) || 0) >= 1000) return true;
          el = el.parentElement;
        }
        return false;
      }
      function isShown(iframe) {
        const rect = iframe.getBoundingClientRect();
        if (rect.width < 2 || rect.height < 2) return false;
        const style = getComputedStyle(iframe);
        return style.display !== 'none' && style.visibility !== 'hidden';
      }
      // A src keyword must sit in host or path: ad and tracking frames often
      // carry "cookie=" or "privacy=" in their query string.
      function srcKeywordMatches(iframe, sel) {
        const prefix = 'iframe[src*="';
        if (!sel.startsWith(prefix)) return true;
        const keyword = sel.slice(prefix.length, sel.indexOf('"', prefix.length));
        try {
          const url = new URL(iframe.src, location.href);
          return (url.hostname + url.pathname).toLowerCase().includes(keyword);
        } catch {
          return false;
        }
      }
      function findFrame(sel) {
        for (const iframe of document.querySelectorAll(sel)) {
          if (!isShown(iframe) || !srcKeywordMatches(iframe, sel) || !isOverlay(iframe)) continue;
          return iframe;
        }
        return null;
      }

      // Cross-origin consent frames are handed back so the caller can attach to them.
      const crossOrigin = [];
      for (const sel of iframeSelectors) {
        const iframe = findFrame(sel);
        if (!iframe) continue;
        let doc = null;
        try {
          doc = iframe.contentDocument || iframe.contentWindow?.document || null;
        } catch {
          doc = null;
        }
        if (!doc) {
          const locator = iframe.id ? '#' + CSS.escape(iframe.id) : sel;
          if (!crossOrigin.includes(locator)) crossOrigin.push(locator);
          continue;
        }
        const hit = clickAccept(doc);
        if (hit) return { dismissed: true, method: hit.method, detail: sel + ' > ' + hit.detail };
      }
      return { dismissed: false, crossOrigin };
    })()`;

    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const result = await evaluateOnPage<{
        dismissed: boolean;
        method?: "iframe" | "iframe-text";
        detail?: string;
        crossOrigin?: string[];
      }>(conn, { expression, returnByValue: true });
      const value = result.result.value;
      if (!value) return { dismissed: false };
      if (value.dismissed) return { dismissed: true, method: value.method, detail: value.detail };

      const notes: string[] = [];
      for (const frame of value.crossOrigin ?? []) {
        let scope: FrameScope;
        try {
          scope = await this.openFrameScope(conn, targetWsUrl, frame);
        } catch (error) {
          notes.push(`consent iframe ${frame}: ${(error as Error).message}`);
          continue;
        }
        try {
          const inner = await evaluateOnPage<{
            method: "iframe" | "iframe-text";
            detail: string;
          } | null>(scope.client, {
            expression: `(${innerSearch})(document)`,
            returnByValue: true,
          });
          const hit = inner.result.value;
          if (hit) {
            return { dismissed: true, method: hit.method, detail: `${frame} >>> ${hit.detail}` };
          }
          notes.push(`consent iframe ${frame}: no accept button found`);
        } catch (error) {
          notes.push(`consent iframe ${frame}: ${(error as Error).message}`);
        } finally {
          scope.release();
        }
      }
      return notes.length ? { dismissed: false, detail: notes.join("; ") } : { dismissed: false };
    });
  }

  /**
   * Use the CDP Accessibility tree to find and click consent buttons.
   * This works even when consent banners use shadow DOM or obfuscated class names.
   * Also queries cross-origin iframe frames via Page.getFrameTree for Sourcepoint etc.
   */
  private async dismissViaA11y(targetWsUrl: string): Promise<DismissCookieBannerResult> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      await conn.send("Accessibility.enable");
      await conn.send("Page.enable");

      type AXNode = {
        nodeId: string;
        parentId?: string;
        backendDOMNodeId?: number;
        role?: { value: string };
        name?: { value: string };
        properties?: Array<{ name: string; value: { value: unknown } }>;
        ignored?: boolean;
      };

      // Collect a11y nodes from the main frame
      const { nodes } = await conn.send<{ nodes: AXNode[] }>("Accessibility.getFullAXTree");

      // Node sets by origin. Nodes from consent-related iframe URLs are trusted
      // (the whole frame is a CMP); main-frame/about:blank nodes must additionally
      // sit under a dialog/consent-named ancestor before we click anything.
      const nodeSets: Array<{ nodes: AXNode[]; trusted: boolean }> = [{ nodes, trusted: false }];
      try {
        const { frameTree } = await conn.send<{
          frameTree: {
            frame: { id: string };
            childFrames?: Array<{ frame: { id: string; url?: string } }>;
          };
        }>("Page.getFrameTree");
        for (const child of frameTree.childFrames ?? []) {
          const url = child.frame.url ?? "";
          const consentFrame =
            /consent|cookie|privacy|sourcepoint|didomi|cmp|gdpr|trustarc|consentmanager|sp_message|onetrust|usercentrics|consent-cdn/i.test(
              url,
            );
          // Only query frames that look consent-related
          if (consentFrame || url === "about:blank") {
            try {
              const frameResult = await conn.send<{ nodes: AXNode[] }>(
                "Accessibility.getFullAXTree",
                { frameId: child.frame.id },
              );
              nodeSets.push({ nodes: frameResult.nodes, trusted: consentFrame });
            } catch {
              // frame may have been destroyed — skip
            }
          }
        }
      } catch {
        // Page.getFrameTree failed — proceed with main frame only
      }

      // Consent-related name patterns (EN, DE, FR, ES, IT, NL, PT, PL, SV, DA, NO)
      const consentPatterns = [
        // English
        /accept\s*(all)?\s*(cookies)?/i,
        /allow\s*(all)?\s*(cookies)?/i,
        /(i\s+)?agree(\s+to\s+all)?/i,
        /got\s*it/i,
        /^ok$/i,
        /^consent$/i,
        // German
        /(alle\s+)?akzeptieren/i,
        /alle\s+cookies\s+akzeptieren/i,
        /(alle\s+)?zustimmen/i,
        /einwilligen/i,
        /einverstanden/i,
        /alles\s+erlauben/i,
        /alles\s+akzeptieren/i,
        /geht\s+klar/i,
        /verstanden/i,
        // French
        /(j')?accepte(r)?(\s+tout)?/i,
        /(tout\s+)?accepter/i,
        /autoriser/i,
        // Spanish
        /aceptar(\s+todo)?/i,
        /aceptar\s+cookies/i,
        // Italian
        /accett(a|o)(\s+tutt[oi])?/i,
        /accetta\s+cookies/i,
        // Dutch
        /(alle\s+)?accepteren/i,
        /alles\s+accepteren/i,
        // Portuguese
        /aceitar(\s+tudo)?/i,
        /aceitar\s+cookies/i,
        // Polish
        /akceptuj(\s+wszystk[oi]e)?/i,
        /zgadzam\s+si/i,
        // Swedish
        /acceptera(\s+alla)?/i,
        // Danish
        /accepter(\s+alle)?/i,
        // Norwegian
        /aksepter(\s+alle)?/i,
      ];

      // Ancestor gate for untrusted node sets: the candidate must sit under a
      // dialog/alertdialog or an ancestor whose accessible name mentions
      // cookies/consent — otherwise the loose name patterns would click
      // arbitrary page buttons ("Accept invitation", "I agree" form submits).
      const consentAncestorName = /cookie|consent|privacy|gdpr|datenschutz|einwillig|zustimm/i;
      const hasConsentAncestor = (byId: Map<string, AXNode>, node: AXNode): boolean => {
        let current: AXNode | undefined = node.parentId ? byId.get(node.parentId) : undefined;
        let depth = 0;
        while (current && depth < 50) {
          const role = current.role?.value;
          if (role === "dialog" || role === "alertdialog") return true;
          const name = current.name?.value;
          if (name && consentAncestorName.test(name)) return true;
          current = current.parentId ? byId.get(current.parentId) : undefined;
          depth++;
        }
        return false;
      };

      // Find button/link nodes whose accessible name matches consent patterns
      const candidates: Array<{ nodeId: string; backendDOMNodeId: number; name: string }> = [];
      for (const { nodes: setNodes, trusted } of nodeSets) {
        const byId = new Map<string, AXNode>(setNodes.map((n) => [n.nodeId, n]));
        for (const node of setNodes) {
          if (node.ignored) continue;
          const role = node.role?.value;
          if (role !== "button" && role !== "link") continue;
          const name = node.name?.value?.trim();
          if (!name || name.length > 50) continue;

          // Check if the button is focusable/not disabled
          const isDisabled = node.properties?.some(
            (p) => p.name === "disabled" && p.value.value === true,
          );
          if (isDisabled) continue;

          for (const pat of consentPatterns) {
            if (pat.test(name) && node.backendDOMNodeId) {
              if (trusted || hasConsentAncestor(byId, node)) {
                candidates.push({
                  nodeId: node.nodeId,
                  backendDOMNodeId: node.backendDOMNodeId,
                  name,
                });
              }
              break;
            }
          }
        }
      }

      if (candidates.length === 0) {
        return { dismissed: false };
      }

      // Click the first matching candidate via CDP DOM.focus + Runtime.evaluate
      const target = candidates[0];
      try {
        // Resolve the DOM node to get a JS object reference
        const { object } = await conn.send<{ object: { objectId?: string } }>("DOM.resolveNode", {
          backendNodeId: target.backendDOMNodeId,
        });
        if (object?.objectId) {
          // Call click() on the resolved object
          await conn.send("Runtime.callFunctionOn", {
            objectId: object.objectId,
            functionDeclaration: "function() { this.click(); }",
            returnByValue: true,
          });
          return { dismissed: true, method: "a11y" as const, detail: target.name };
        }
      } catch {
        // If DOM.resolveNode fails, try clicking via JS selector fallback
      }

      return { dismissed: false };
    });
  }

  terminate(pid: number): void {
    if (pid === 0) return; // external browser — don't kill
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore if already closed
    }
  }
}

export class MockBrowserController implements BrowserController {
  private readonly pages = new Map<
    string,
    { url: string; title: string; text: string; html: string }
  >();

  async launch(
    sessionId: string,
    _options?: LaunchOptions,
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }> {
    const cdpUrl = `mock://${sessionId}`;
    const targetWsUrl = cdpUrl;
    this.pages.set(cdpUrl, {
      url: "about:blank",
      title: "about:blank",
      text: "",
      html: "<html><body></body></html>",
    });
    return { pid: 1, cdpUrl, targetWsUrl };
  }

  async connect(
    cdpUrl: string,
    _options?: { userAgent?: string },
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }> {
    this.pages.set(cdpUrl, {
      url: "about:blank",
      title: "about:blank",
      text: "",
      html: "<html><body></body></html>",
    });
    return { pid: 0, cdpUrl, targetWsUrl: cdpUrl };
  }

  async navigate(cdpUrl: string, url: string): Promise<string> {
    const page = this.pages.get(cdpUrl);
    if (!page) throw new Error("mock page missing");
    page.url = url;
    page.title = url;
    page.text = `Content of ${url}`;
    page.html = `<html><body>${page.text}</body></html>`;
    // Track navigation history for goBack/goForward
    this.history.splice(this.historyIndex + 1);
    this.history.push(url);
    this.historyIndex = this.history.length - 1;
    return url;
  }

  private readonly history: string[] = [];
  private historyIndex = -1;

  async interact(cdpUrl: string, payload: InteractPayload): Promise<string> {
    if (payload.action === "goBack") {
      if (this.historyIndex <= 0) return "no history to go back";
      this.historyIndex--;
      const page = this.pages.get(cdpUrl);
      if (page) page.url = this.history[this.historyIndex] ?? page.url;
      return `navigated back to ${page?.url ?? "previous page"}`;
    }
    if (payload.action === "goForward") {
      if (this.historyIndex >= this.history.length - 1) return "no history to go forward";
      this.historyIndex++;
      const page = this.pages.get(cdpUrl);
      if (page) page.url = this.history[this.historyIndex] ?? page.url;
      return `navigated forward to ${page?.url ?? "next page"}`;
    }
    if (payload.action === "refresh") return "page refreshed";
    if (payload.action === "dialog") {
      const dismiss = payload.text === "dismiss";
      return dismiss ? "dismissed confirm: mock dialog" : "accepted confirm: mock dialog";
    }
    return `interacted:${payload.action}`;
  }

  async screenshot(_targetWsUrl: string, options?: ScreenshotOptions): Promise<ScreenshotResult> {
    const format = options?.format ?? "jpeg";
    return {
      data: "bW9jaw==",
      mimeType: format === "png" ? "image/png" : "image/jpeg",
    };
  }

  async getCurrentUrl(cdpUrl: string): Promise<string> {
    const page = this.pages.get(cdpUrl);
    return page?.url ?? "about:blank";
  }

  private readonly tabs = new Map<string, string[]>();
  private tabCounter = 0;

  /** Tab ids are the page keys (targetWsUrl); the initial page is the cdpUrl itself. */
  private tabIds(cdpUrl: string): string[] {
    let ids = this.tabs.get(cdpUrl);
    if (!ids) {
      ids = this.pages.has(cdpUrl) ? [cdpUrl] : [];
      this.tabs.set(cdpUrl, ids);
    }
    return ids;
  }

  async getPageState(targetWsUrl: string): Promise<PageState> {
    const page = this.pages.get(targetWsUrl);
    if (!page) throw new Error("mock page missing");
    return { url: page.url, title: page.title, readyState: "complete" };
  }

  async listTabs(cdpUrl: string): Promise<TabInfo[]> {
    return this.tabIds(cdpUrl).map((id) => {
      const page = this.pages.get(id);
      return { id, url: page?.url ?? "about:blank", title: page?.title ?? "", targetWsUrl: id };
    });
  }

  async openTab(cdpUrl: string): Promise<TabInfo> {
    this.tabCounter += 1;
    const id = `${cdpUrl}/tab-${this.tabCounter}`;
    this.pages.set(id, {
      url: "about:blank",
      title: "about:blank",
      text: "",
      html: "<html><body></body></html>",
    });
    this.tabIds(cdpUrl).push(id);
    return { id, url: "about:blank", title: "about:blank", targetWsUrl: id };
  }

  async activateTab(cdpUrl: string, tabId: string): Promise<void> {
    if (!this.tabIds(cdpUrl).includes(tabId)) throw new Error(`Tab not found: ${tabId}`);
  }

  async closeTab(cdpUrl: string, tabId: string): Promise<void> {
    const ids = this.tabIds(cdpUrl);
    const index = ids.indexOf(tabId);
    if (index === -1) throw new Error(`Tab not found: ${tabId}`);
    ids.splice(index, 1);
    this.pages.delete(tabId);
  }

  async getContent(cdpUrl: string, options: PageContentOptions): Promise<PageContentResult> {
    const page = this.pages.get(cdpUrl);
    if (!page) throw new Error("mock page missing");
    if (options.mode === "summary") {
      return {
        mode: "summary",
        content: "",
        structuredContent: {
          mode: "summary",
          url: page.url,
          title: page.title,
          headings: [page.title],
          landmarks: [],
          alerts: [],
          frames: [],
          primaryActions: [],
          inputs: [],
          totalInteractiveElements: 0,
          truncatedInteractiveElements: false,
        },
      };
    }

    const raw =
      options.mode === "title" ? page.title : options.mode === "html" ? page.html : page.text;
    const limited = applyContentLimit(raw, options.maxChars);
    return {
      mode: options.mode,
      content: limited.content,
      truncated: limited.truncated || undefined,
      originalLength: limited.originalLength,
    };
  }

  async getInteractiveElements(
    _targetWsUrl: string,
    _options: InteractiveElementsOptions,
  ): Promise<InteractiveElementsResult> {
    return { elements: [], totalFound: 0, truncated: false };
  }

  async dismissCookieBanner(_targetWsUrl: string): Promise<DismissCookieBannerResult> {
    return { dismissed: false };
  }

  terminate(_pid: number): void {}

  closeConnection(_targetWsUrl: string): void {}
}
