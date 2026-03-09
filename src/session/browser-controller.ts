import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { discoverChrome } from "./chrome-launcher.js";

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
}

export interface InteractiveElementsOptions {
  roles?: InteractiveElementRole[];
  visibleOnly?: boolean;
  limit?: number;
  selector?: string;
}

export interface InteractiveElementsResult {
  elements: InteractiveElement[];
  totalFound: number;
  truncated: boolean;
}

export interface LaunchOptions {
  executablePath?: string;
  userProfileDir?: string;
  headless?: boolean;
  userAgent?: string;
}

export interface DismissCookieBannerResult {
  dismissed: boolean;
  method?: "a11y" | "selector" | "text";
  detail?: string;
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
  terminate(pid: number): void;
  closeConnection?(targetWsUrl: string): void;
}

interface CdpTarget {
  id: string;
  type: string;
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
  const maxMs = 15000;
  const start = Date.now();
  let delay = 50; // exponential backoff: 50 → 100 → 200 → 250 (capped)

  while (Date.now() - start < maxMs) {
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
    delay = Math.min(delay * 2, 250);
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

/** Verify the page is ready and optionally set a custom user-agent, using a single connection. */
async function initTarget(targetWsUrl: string, userAgent?: string): Promise<void> {
  const conn = await CdpConnection.connect(targetWsUrl);
  try {
    const enables: Promise<unknown>[] = [conn.send("Page.enable"), conn.send("Runtime.enable")];
    if (userAgent) {
      enables.push(conn.send("Network.enable"));
    }
    await Promise.all(enables);
    await conn.send("Runtime.evaluate", {
      expression: "window.location.href",
      returnByValue: true,
      awaitPromise: true,
    });
    if (userAgent) {
      await conn.send("Network.setUserAgentOverride", { userAgent });
    }
  } finally {
    conn.close();
  }
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

      function resolveLocator(locator) {
        const parts = splitLocator(locator);
        if (parts.length === 0) return null;

        let root = document;
        let element = null;
        for (let index = 0; index < parts.length; index += 1) {
          element = root.querySelector(parts[index]);
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
        throw new Error('Selector not found');
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

  private readonly cleanupInterval: ReturnType<typeof setInterval>;

  constructor(
    private readonly baseDir: string,
    private readonly connectionFactory: (
      targetWsUrl: string,
    ) => Promise<CdpClient> = CdpConnection.connect,
  ) {
    // Evict connections idle for >5 minutes
    this.cleanupInterval = setInterval(() => {
      const cutoff = Date.now() - 5 * 60 * 1000;
      for (const [url, entry] of this.connections) {
        if (entry.lastUsedAt < cutoff) {
          this.dropConnection(url);
        }
      }
    }, 60_000);
    this.cleanupInterval.unref();
  }

  private async getConnection(targetWsUrl: string): Promise<CdpClient> {
    const cached = this.connections.get(targetWsUrl);
    if (cached) {
      cached.lastUsedAt = Date.now();
      return cached.conn;
    }

    const conn = await this.connectionFactory(targetWsUrl);
    this.connections.set(targetWsUrl, {
      conn,
      enabled: { page: false, runtime: false },
      lastUsedAt: Date.now(),
    });
    return conn;
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
    await initTarget(targetWsUrl, options?.userAgent);
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
    fs.mkdirSync(profileDir, { recursive: true });

    // Chrome locks its profile with a "SingletonLock" file. If present, another
    // Chrome instance owns this profile and a new launch will silently fail.
    const lockFile = path.join(profileDir, "SingletonLock");
    if (fs.existsSync(lockFile)) {
      throw new Error(
        `Chrome profile is already in use (lock file exists: ${lockFile}). ` +
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
        await initTarget(targetWsUrl, userAgent);
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

  /** Execute fn with a pooled connection; on failure drop connection and retry once. */
  private async withRetry<T>(targetWsUrl: string, fn: (conn: CdpClient) => Promise<T>): Promise<T> {
    let conn = await this.getConnection(targetWsUrl);
    try {
      return await fn(conn);
    } catch {
      this.dropConnection(targetWsUrl);
      conn = await this.getConnection(targetWsUrl);
      return await fn(conn);
    }
  }

  async navigate(targetWsUrl: string, url: string): Promise<string> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);

      // Listen for frameNavigated to capture the final URL from the event itself,
      // avoiding a separate Runtime.evaluate round-trip.
      const navigatedPromise = conn
        .waitForEvent<{ frame?: { url?: string } }>("Page.frameNavigated", 6000)
        .catch(() => undefined);
      const loadPromise = Promise.race([
        conn.waitForEvent("Page.loadEventFired", 6000),
        conn.waitForEvent("Page.frameStoppedLoading", 6000),
      ]);

      const navResult = await conn.send<{ errorText?: string }>("Page.navigate", { url });
      if (navResult.errorText) {
        throw new Error(`Navigation failed: ${navResult.errorText}`);
      }

      const navigatedEvent = await navigatedPromise;
      try {
        await loadPromise;
      } catch {
        // page may still be usable
      }

      return navigatedEvent?.frame?.url ?? url;
    });
  }

  private async handleDialogAction(targetWsUrl: string, payload: InteractPayload): Promise<string> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const cached = this.connections.get(targetWsUrl);

      // If no pending dialog, briefly wait for one (500ms)
      if (!cached?.pendingDialog) {
        try {
          await conn.waitForEvent("Page.javascriptDialogOpening", 500);
          // Give the listener time to populate pendingDialog
          await new Promise((r) => setTimeout(r, 50));
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

    const result = await conn.send<{ result: { value?: { x?: number; y?: number } } }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    );

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

    const result = await conn.send<{ result: { value?: "ready" | "cleared" } }>(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
    );

    return result.result.value ?? "ready";
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

    await conn.send("Runtime.evaluate", {
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
        const navigatedPromise = conn
          .waitForEvent<{ frame?: { url?: string } }>("Page.frameNavigated", 3000)
          .catch(() => undefined);
        await conn.send("Runtime.evaluate", {
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
        const navigatedPromise = conn
          .waitForEvent<{ frame?: { url?: string } }>("Page.frameNavigated", 3000)
          .catch(() => undefined);
        await conn.send("Runtime.evaluate", {
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
      return await this.withRetry(targetWsUrl, async (conn) => {
        await this.ensureEnabled(targetWsUrl);

        if (payload.action === "click") {
          const point = await this.preparePointerTarget(conn, payload);
          await this.dispatchMouseClick(conn, point.x, point.y);

          try {
            await conn.waitForEvent("Page.frameNavigated", 50);
            try {
              await Promise.race([
                conn.waitForEvent("Page.loadEventFired", 3000),
                conn.waitForEvent("Page.frameStoppedLoading", 3000),
              ]);
            } catch {
              // load didn't fire in time — page may still be usable
            }
          } catch {
            // No navigation happened – that's fine for non-navigating clicks
          }

          return "clicked";
        }

        if (payload.action === "hover") {
          const point = await this.preparePointerTarget(conn, payload);
          await conn.send("Input.dispatchMouseEvent", {
            type: "mouseMoved",
            x: point.x,
            y: point.y,
            button: "none",
          });
          return "hovered";
        }

        if (payload.action === "press") {
          await this.focusTarget(conn, payload);
          await this.dispatchKeyPress(conn, payload.key);
          return "pressed";
        }

        const preparation = await this.prepareTypeTarget(conn, payload);
        if (preparation === "ready") {
          await conn.send("Input.insertText", { text: payload.text ?? "" });
        }
        return "typed";
      });
    }

    const expression = buildLocatorRuntimeExpression(
      "payload",
      payload,
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
        return typeof result === 'string' ? result : JSON.stringify(result);
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

    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const result = await conn.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      return result.result.value ?? "";
    });
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
      const result = await conn.send<{ result: { value?: RuntimeContentPayload } }>(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
      );
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

      return {
        url: window.location.href,
        title: document.title ?? '',
        headings,
        landmarks,
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
      const result = await conn.send<{ result: { value?: Record<string, unknown> } }>(
        "Runtime.evaluate",
        {
          expression,
          returnByValue: true,
          awaitPromise: true,
        },
      );
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
        const selected = await conn.send<{ result: { objectId?: string; subtype?: string } }>(
          "Runtime.evaluate",
          {
            expression: buildLocatorRuntimeExpression(
              "selector",
              selector,
              `
      return resolveLocator(selector);
`,
            ),
            objectGroup,
          },
        );
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
        return parts.join(' > ');
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

      function viewForElement(el) {
        return el.ownerDocument && el.ownerDocument.defaultView ? el.ownerDocument.defaultView : window;
      }

      function isVisible(el) {
        const style = viewForElement(el).getComputedStyle(el);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
          return false;
        }
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      }

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

      const results = [];
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

        totalFound += 1;
        if (results.length >= limit) return;

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

        results.push(entry);
      }

      function walkRoot(root, path) {
        const queue = rootEntries(root).slice();
        while (queue.length) {
          const current = queue.shift();
          if (!current || current.nodeType !== 1) continue;

          maybeRecordElement(root, path, current);

          if (current.shadowRoot) {
            walkRoot(current.shadowRoot, path.concat(buildSelector(root, current)));
          }

          if (current.tagName && current.tagName.toLowerCase() === 'iframe') {
            try {
              if (current.contentDocument) {
                walkRoot(current.contentDocument, path.concat(buildSelector(root, current)));
              }
            } catch {
              // ignore inaccessible frames
            }
          }

          for (const child of Array.from(current.children)) {
            queue.push(child);
          }
        }
      }

      walkRoot(document, []);
      return { elements: results, totalFound, truncated: totalFound > results.length };
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
      const result = await conn.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      return extract(result);
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
    // Strategy 1: Cheap DOM scan first for fast-path common consent banners.
    try {
      const domResult = await this.dismissViaDom(targetWsUrl);
      if (domResult.dismissed) return domResult;
    } catch {
      // DOM approach failed — fall through to a11y-based fallback
    }

    // Strategy 2: Use the accessibility tree when DOM heuristics miss.
    try {
      const a11yResult = await this.dismissViaA11y(targetWsUrl);
      if (a11yResult.dismissed) return a11yResult;
    } catch {
      // a11y approach failed — return false below
    }

    return { dismissed: false };
  }

  private async dismissViaDom(targetWsUrl: string): Promise<DismissCookieBannerResult> {
    const expression = `(() => {
      // Common cookie-consent button selectors (ordered by specificity)
      const selectors = [
        '#onetrust-accept-btn-handler',
        '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
        '#CybotCookiebotDialogBodyButtonAccept',
        '#accept-cookies', '#acceptCookies',
        '#cookie-accept', '#cookieAccept',
        '#gdpr-accept', '#consent-accept',
        '#uc-btn-accept-banner',
        '.cc-accept', '.cc-btn.cc-dismiss',
        '.cookie-consent-accept', '.cookie-accept-btn',
        '.js-cookie-accept', '.js-accept-cookies',
        '.consent-accept', '.consent-btn-accept',
        '.gdpr-accept',
        '[data-testid="cookie-accept"]',
        '[data-action="accept-cookies"]',
        '[data-cookiefirst-action="accept"]',
      ];

      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) {
          el.click();
          return JSON.stringify({ dismissed: true, method: 'selector', detail: sel });
        }
      }

      // Text-based fallback: find visible buttons with consent text
      const patterns = [
        /^accept\\s*(all)?\\s*(cookies)?$/i,
        /^(alle\\s+)?akzeptieren$/i,
        /^(i\\s+)?agree$/i,
        /^allow\\s*(all)?\\s*(cookies)?$/i,
        /^(alle\\s+)?zustimmen$/i,
        /^got\\s*it$/i,
        /^ok$/i,
        /^consent$/i,
        /^(j')?accepte(r)?$/i,
        /^(tout\\s+)?accepter$/i,
      ];
      const candidates = [
        ...document.querySelectorAll('button'),
        ...document.querySelectorAll('a[role="button"]'),
        ...document.querySelectorAll('[role="button"]'),
      ];
      for (const el of candidates) {
        if (!el.offsetParent) continue;
        const text = (el.textContent || '').trim();
        if (text.length > 40) continue;
        for (const pat of patterns) {
          if (pat.test(text)) {
            el.click();
            return JSON.stringify({ dismissed: true, method: 'text', detail: text });
          }
        }
      }

      return JSON.stringify({ dismissed: false });
    })()`;

    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const result = await conn.send<{ result: { value?: string } }>("Runtime.evaluate", {
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
   * Use the CDP Accessibility tree to find and click consent buttons.
   * This works even when consent banners use shadow DOM, iframes, or obfuscated class names.
   */
  private async dismissViaA11y(targetWsUrl: string): Promise<DismissCookieBannerResult> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      await conn.send("Accessibility.enable");

      const { nodes } = await conn.send<{
        nodes: Array<{
          nodeId: string;
          parentId?: string;
          backendDOMNodeId?: number;
          role?: { value: string };
          name?: { value: string };
          properties?: Array<{ name: string; value: { value: unknown } }>;
          ignored?: boolean;
        }>;
      }>("Accessibility.getFullAXTree");

      // Consent-related name patterns (EN, DE, FR, ES, IT, NL, PT)
      const consentPatterns = [
        /^accept\s*(all)?\s*(cookies)?$/i,
        /^(i\s+)?agree(\s+to\s+all)?$/i,
        /^allow\s*(all)?\s*(cookies)?$/i,
        /^got\s*it$/i,
        /^ok$/i,
        /^consent$/i,
        /^(alle\s+)?akzeptieren$/i,
        /^(alle\s+)?zustimmen$/i,
        /^einverstanden$/i,
        /^(j')?accepte(r)?(\s+tout)?$/i,
        /^(tout\s+)?accepter$/i,
        /^aceptar(\s+todo)?$/i,
        /^accetta(\s+tutto)?$/i,
        /^accepteren$/i,
        /^alle\s+accepteren$/i,
        /^aceitar(\s+tudo)?$/i,
      ];

      // Find button/link nodes whose accessible name matches consent patterns
      const candidates: Array<{ nodeId: string; backendDOMNodeId: number; name: string }> = [];
      for (const node of nodes) {
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
            candidates.push({ nodeId: node.nodeId, backendDOMNodeId: node.backendDOMNodeId, name });
            break;
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
