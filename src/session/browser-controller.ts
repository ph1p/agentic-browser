import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import WebSocket from "ws";

import { discoverChrome } from "./chrome-launcher.js";
import { loadControlExtension } from "./extension-loader.js";

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

export type PageContentMode = "title" | "text" | "html" | "a11y";

export interface PageContentOptions {
  mode: PageContentMode;
  selector?: string;
}

export interface PageContentResult {
  mode: PageContentMode;
  content: string;
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
  terminate(pid: number): void;
  closeConnection?(targetWsUrl: string): void;
}

interface CdpTarget {
  id: string;
  type: string;
  webSocketDebuggerUrl?: string;
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

class CdpConnection implements CdpClient {
  private nextId = 0;

  constructor(private readonly ws: WebSocket) {}

  static async connect(targetWsUrl: string): Promise<CdpConnection> {
    const ws = new WebSocket(targetWsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
    return new CdpConnection(ws);
  }

  async send<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = 15000,
  ): Promise<T> {
    const id = ++this.nextId;
    const payload = { id, method, params };

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.off("message", onMessage);
        reject(new Error(`CDP call '${method}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString("utf8")) as {
          id?: number;
          result?: T;
          error?: { message: string };
        };
        if (message.id !== id) {
          return;
        }

        clearTimeout(timeout);
        this.ws.off("message", onMessage);
        if (message.error) {
          reject(new Error(message.error.message));
          return;
        }
        resolve((message.result ?? {}) as T);
      };

      this.ws.on("message", onMessage);
      this.ws.send(JSON.stringify(payload));
    });
  }

  waitForEvent<T = unknown>(method: string, timeoutMs = 5000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ws.off("message", onMessage);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);

      const onMessage = (raw: WebSocket.RawData) => {
        const message = JSON.parse(raw.toString("utf8")) as {
          method?: string;
          params?: T;
        };
        if (message.method !== method) {
          return;
        }
        clearTimeout(timeout);
        this.ws.off("message", onMessage);
        resolve((message.params ?? {}) as T);
      };

      this.ws.on("message", onMessage);
    });
  }

  onEvent<T = unknown>(method: string, handler: (params: T) => void): () => void {
    const onMessage = (raw: WebSocket.RawData) => {
      const message = JSON.parse(raw.toString("utf8")) as {
        method?: string;
        params?: T;
      };
      if (message.method === method) {
        handler((message.params ?? {}) as T);
      }
    };
    this.ws.on("message", onMessage);
    return () => {
      this.ws.off("message", onMessage);
    };
  }

  close(): void {
    this.ws.close();
  }
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url);
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

  constructor(
    private readonly baseDir: string,
    private readonly connectionFactory: (
      targetWsUrl: string,
    ) => Promise<CdpClient> = CdpConnection.connect,
  ) {}

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
    const extension = loadControlExtension();
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

    const launchAttempts: Array<{ withExtension: boolean; headless: boolean }> = headless
      ? [{ withExtension: false, headless: true }]
      : [
          { withExtension: true, headless: false },
          { withExtension: false, headless: false },
          { withExtension: false, headless: true },
        ];

    let lastError: Error | undefined;

    for (const attempt of launchAttempts) {
      const port = await getFreePort();
      const args = [
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--no-default-browser-check",
      ];

      if (attempt.withExtension) {
        args.push(
          `--disable-extensions-except=${extension.extensionPath}`,
          `--load-extension=${extension.extensionPath}`,
        );
      }

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

      await conn.send("Page.navigate", { url });

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

    const p = JSON.stringify(payload);
    const expression = `(async () => {
      const payload = ${p};

      function resolveElement(selector, fallbacks) {
        let el = selector ? document.querySelector(selector) : null;
        if (el) return el;
        if (fallbacks && fallbacks.length) {
          for (const fb of fallbacks) {
            el = document.querySelector(fb);
            if (el) return el;
          }
        }
        throw new Error('Selector not found');
      }

      if (payload.action === 'click') {
        const el = resolveElement(payload.selector, payload.fallbackSelectors);
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) {
          throw new Error('Element has zero size – it may be hidden or not rendered');
        }
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);
        if (topEl && topEl !== el && !el.contains(topEl) && !topEl.contains(el)) {
          const tag = topEl.tagName.toLowerCase();
          const id = topEl.id ? '#' + topEl.id : '';
          const cls = topEl.className && typeof topEl.className === 'string' ? '.' + topEl.className.split(' ').join('.') : '';
          throw new Error('Element is covered by another element: ' + tag + id + cls);
        }
        el.click();
        return 'clicked';
      }
      if (payload.action === 'type') {
        const el = resolveElement(payload.selector, payload.fallbackSelectors);
        el.focus();
        el.value = payload.text ?? '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'typed';
      }
      if (payload.action === 'press') {
        const target = document.activeElement;
        if (!target) throw new Error('No active element to press key on');
        const key = payload.key ?? 'Enter';
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }));
        return 'pressed';
      }
      if (payload.action === 'waitFor') {
        const timeout = payload.timeoutMs ?? 2000;
        const started = Date.now();
        while (Date.now() - started < timeout) {
          if (document.querySelector(payload.selector)) {
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
          const el = resolveElement(payload.selector, payload.fallbackSelectors);
          el.scrollBy({ left: payload.scrollX ?? 0, top: payload.scrollY ?? 0, behavior: 'smooth' });
          return 'scrolled element';
        }
        window.scrollBy({ left: payload.scrollX ?? 0, top: payload.scrollY ?? 0, behavior: 'smooth' });
        return 'scrolled page';
      }
      if (payload.action === 'hover') {
        const el = resolveElement(payload.selector, payload.fallbackSelectors);
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true, clientX: cx, clientY: cy }));
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: cx, clientY: cy }));
        el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
        return 'hovered';
      }
      if (payload.action === 'select') {
        const el = resolveElement(payload.selector, payload.fallbackSelectors);
        if (el.tagName.toLowerCase() !== 'select') throw new Error('Element is not a <select>');
        el.value = payload.value ?? '';
        el.dispatchEvent(new Event('change', { bubbles: true }));
        el.dispatchEvent(new Event('input', { bubbles: true }));
        return 'selected ' + el.value;
      }
      if (payload.action === 'toggle') {
        const el = resolveElement(payload.selector, payload.fallbackSelectors);
        el.click();
        const checked = el.checked !== undefined ? el.checked : el.getAttribute('aria-checked') === 'true';
        return 'toggled to ' + (checked ? 'checked' : 'unchecked');
      }
      throw new Error('Unsupported interact action');
    })()`;

    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const result = await conn.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      const value = result.result.value ?? "";

      // After a click, check briefly if navigation starts (50ms instead of 500ms).
      // Most clicks don't navigate, so a short timeout avoids penalising the common case.
      if (payload.action === "click" && value === "clicked") {
        try {
          await conn.waitForEvent("Page.frameNavigated", 50);
          // Navigation started — wait for it to finish loading (up to 3s).
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
      }

      return value;
    });
  }

  async getContent(targetWsUrl: string, options: PageContentOptions): Promise<PageContentResult> {
    if (options.mode === "a11y") {
      const content = await this.getAccessibilityTree(targetWsUrl);
      return { mode: "a11y", content };
    }

    const o = JSON.stringify(options);
    const expression = `(() => {
      const options = ${o};
      if (options.mode === 'title') return document.title ?? '';
      if (options.mode === 'html') {
        if (options.selector) {
          const el = document.querySelector(options.selector);
          return el ? el.outerHTML : '';
        }
        return document.documentElement?.outerHTML ?? '';
      }
      if (options.selector) {
        const el = document.querySelector(options.selector);
        return el ? el.innerText ?? '' : '';
      }
      return document.body?.innerText ?? '';
    })()`;

    return await this.withRetry(targetWsUrl, async (conn) => {
      await this.ensureEnabled(targetWsUrl);
      const result = await conn.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      const content = result.result.value ?? "";
      return { mode: options.mode, content };
    });
  }

  private async getAccessibilityTree(targetWsUrl: string): Promise<string> {
    return await this.withRetry(targetWsUrl, async (conn) => {
      await conn.send("Accessibility.enable");

      const { nodes } = await conn.send<{
        nodes: Array<{
          nodeId: string;
          parentId?: string;
          role?: { value: string };
          name?: { value: string };
          value?: { value: string };
          description?: { value: string };
          properties?: Array<{ name: string; value: { value: unknown } }>;
          childIds?: string[];
          ignored?: boolean;
        }>;
      }>("Accessibility.getFullAXTree");

      // Build parent→children map
      const childrenMap = new Map<string, string[]>();
      const nodeMap = new Map<string, (typeof nodes)[0]>();
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

        // Skip ignored nodes and generic containers with no name
        if (node.ignored) {
          // Still traverse children — ignored containers may have visible children
          const children = childrenMap.get(nodeId) ?? node.childIds ?? [];
          for (const childId of children) {
            formatNode(childId, depth);
          }
          return;
        }

        // Skip noise: unnamed generic/group nodes just add indentation
        const skip =
          !name && !value && (role === "generic" || role === "none" || role === "GenericContainer");
        if (!skip) {
          const indent = "  ".repeat(depth);
          let line = `${indent}${role}`;
          if (name) line += ` "${name}"`;
          if (value) line += ` value="${value}"`;

          // Append key states (checked, expanded, selected, disabled, etc.)
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

      // Find root(s) — nodes without parentId
      const roots = nodes.filter((n) => !n.parentId);
      for (const root of roots) {
        formatNode(root.nodeId, 0);
      }

      return lines.join("\n");
    });
  }

  async getInteractiveElements(
    targetWsUrl: string,
    options: InteractiveElementsOptions,
  ): Promise<InteractiveElementsResult> {
    const o = JSON.stringify(options);
    const expression = `(() => {
      const options = ${o};
      const visibleOnly = options.visibleOnly !== false;
      const limit = options.limit ?? 50;
      const scopeSelector = options.selector;
      const roleFilter = options.roles ? new Set(options.roles) : null;

      const root = scopeSelector
        ? document.querySelector(scopeSelector) ?? document.body
        : document.body;

      const candidates = root.querySelectorAll([
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
        '[contenteditable=""]',
      ].join(','));

      const seen = new Set();

      function classifyRole(el) {
        const tag = el.tagName.toLowerCase();
        const ariaRole = el.getAttribute('role');
        if (tag === 'a') return 'link';
        if (tag === 'button' || ariaRole === 'button') return 'button';
        if (tag === 'input') {
          const t = (el.type || 'text').toLowerCase();
          if (t === 'checkbox') return 'checkbox';
          if (t === 'radio') return 'radio';
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
          case 'link': case 'button': case 'custom': return ['click'];
          case 'input': {
            const t = (el.type || 'text').toLowerCase();
            if (t === 'submit' || t === 'reset' || t === 'button' || t === 'file') return ['click'];
            return ['click', 'type', 'press'];
          }
          case 'textarea': case 'contenteditable': return ['click', 'type', 'press'];
          case 'select': return ['click', 'select'];
          case 'checkbox': case 'radio': return ['click', 'toggle'];
          default: return ['click'];
        }
      }

      function escapeAttr(value) {
        return value.replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"');
      }

      function tryUniqueSelector(sel) {
        try { return document.querySelectorAll(sel).length === 1 ? sel : null; }
        catch { return null; }
      }

      function buildSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);

        const name = el.getAttribute('name');
        if (name) {
          const tag = el.tagName.toLowerCase();
          const sel = tryUniqueSelector(tag + '[name="' + escapeAttr(name) + '"]');
          if (sel) return sel;
        }

        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
        if (testId) {
          const attr = el.hasAttribute('data-testid') ? 'data-testid' : 'data-test-id';
          const sel = tryUniqueSelector('[' + attr + '="' + escapeAttr(testId) + '"]');
          if (sel) return sel;
        }

        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
          const tag = el.tagName.toLowerCase();
          const sel = tryUniqueSelector(tag + '[aria-label="' + escapeAttr(ariaLabel) + '"]');
          if (sel) return sel;
        }

        const dataCy = el.getAttribute('data-cy');
        if (dataCy) {
          const sel = tryUniqueSelector('[data-cy="' + escapeAttr(dataCy) + '"]');
          if (sel) return sel;
        }

        const dataTest = el.getAttribute('data-test');
        if (dataTest) {
          const sel = tryUniqueSelector('[data-test="' + escapeAttr(dataTest) + '"]');
          if (sel) return sel;
        }

        const role = el.getAttribute('role');
        if (role && ariaLabel) {
          const sel = tryUniqueSelector('[role="' + escapeAttr(role) + '"][aria-label="' + escapeAttr(ariaLabel) + '"]');
          if (sel) return sel;
        }

        // Path fallback — anchor at nearest ancestor with an id for shorter selectors
        const parts = [];
        let current = el;
        while (current && current !== document.documentElement) {
          const tag = current.tagName.toLowerCase();
          if (current !== el && current.id) {
            parts.unshift('#' + CSS.escape(current.id));
            break;
          }
          const parent = current.parentElement;
          if (!parent) { parts.unshift(tag); break; }
          const siblings = Array.from(parent.children).filter(
            c => c.tagName === current.tagName
          );
          if (siblings.length === 1) {
            parts.unshift(tag);
          } else {
            const idx = siblings.indexOf(current) + 1;
            parts.unshift(tag + ':nth-of-type(' + idx + ')');
          }
          current = parent;
        }
        return parts.join(' > ');
      }

      function buildFallbackSelectors(el, primarySelector) {
        const fallbacks = [];
        const candidates = [];

        if (el.id) candidates.push('#' + CSS.escape(el.id));

        const name = el.getAttribute('name');
        if (name) {
          const tag = el.tagName.toLowerCase();
          const sel = tag + '[name="' + escapeAttr(name) + '"]';
          candidates.push(sel);
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

        for (const sel of candidates) {
          if (sel === primarySelector) continue;
          if (tryUniqueSelector(sel)) fallbacks.push(sel);
          if (fallbacks.length >= 3) break;
        }
        return fallbacks;
      }

      function isVisible(el) {
        const style = window.getComputedStyle(el);
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
          const v = el.value;
          if (v) return v.slice(0, 80);
          const ph = el.getAttribute('placeholder');
          if (ph) return ph.slice(0, 80);
          return el.type || 'text';
        }

        const directText = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent.trim())
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

      const results = [];
      let totalFound = 0;

      for (const el of candidates) {
        if (seen.has(el)) continue;
        seen.add(el);

        const role = classifyRole(el);
        if (roleFilter && !roleFilter.has(role)) continue;

        const vis = isVisible(el);
        if (visibleOnly && !vis) continue;

        totalFound++;
        if (results.length >= limit) continue;

        const primarySelector = buildSelector(el);
        const entry = {
          selector: primarySelector,
          role,
          tagName: el.tagName.toLowerCase(),
          text: getText(el),
          actions: getActions(role, el),
          visible: vis,
          enabled: isEnabled(el),
        };

        const fb = buildFallbackSelectors(el, primarySelector);
        if (fb.length) entry.fallbackSelectors = fb;

        if (role === 'link' && el.href) entry.href = el.href;
        if (role === 'input') entry.inputType = (el.type || 'text').toLowerCase();
        const al = el.getAttribute('aria-label');
        if (al) entry.ariaLabel = al;
        const ph = el.getAttribute('placeholder');
        if (ph) entry.placeholder = ph;

        results.push(entry);
      }

      return { elements: results, totalFound, truncated: totalFound > results.length };
    })()`;

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
    if (options.mode === "title") return { mode: "title", content: page.title };
    if (options.mode === "html") return { mode: "html", content: page.html };
    return { mode: "text", content: page.text };
  }

  async getInteractiveElements(
    _targetWsUrl: string,
    _options: InteractiveElementsOptions,
  ): Promise<InteractiveElementsResult> {
    return { elements: [], totalFound: 0, truncated: false };
  }

  terminate(_pid: number): void {}

  closeConnection(_targetWsUrl: string): void {}
}
