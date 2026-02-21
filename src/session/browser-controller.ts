import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import WebSocket from "ws";

import { discoverChrome } from "./chrome-launcher.js";
import { loadControlExtension } from "./extension-loader.js";

export type InteractAction = "click" | "type" | "press" | "waitFor" | "evaluate";

export interface InteractPayload {
  action: InteractAction;
  selector?: string;
  text?: string;
  key?: string;
  timeoutMs?: number;
}

export interface PageContentOptions {
  mode: "title" | "text" | "html";
  selector?: string;
}

export interface PageContentResult {
  mode: "title" | "text" | "html";
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

export interface BrowserController {
  launch(
    sessionId: string,
    executablePath?: string,
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

async function waitForDebugger(port: number): Promise<void> {
  for (let i = 0; i < 60; i += 1) {
    try {
      await getJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
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

async function evaluateExpression<T>(targetWsUrl: string, expression: string): Promise<T> {
  const conn = await CdpConnection.connect(targetWsUrl);
  try {
    await conn.send("Page.enable");
    await conn.send("Runtime.enable");
    const result = await conn.send<{ result: { value?: T } }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    return (result.result.value as T) ?? ("" as T);
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

export class ChromeCdpBrowserController implements BrowserController {
  private readonly connections = new Map<
    string,
    { conn: CdpClient; enabled: { page: boolean; runtime: boolean }; lastUsedAt: number }
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

  private async ensureEnabled(targetWsUrl: string): Promise<void> {
    const cached = this.connections.get(targetWsUrl);
    if (!cached) {
      return;
    }
    if (!cached.enabled.page) {
      await cached.conn.send("Page.enable");
      cached.enabled.page = true;
    }
    if (!cached.enabled.runtime) {
      await cached.conn.send("Runtime.enable");
      cached.enabled.runtime = true;
    }
  }

  async launch(
    sessionId: string,
    explicitPath?: string,
  ): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }> {
    const executablePath = discoverChrome(explicitPath);
    const extension = loadControlExtension();
    const profileDir = path.join(this.baseDir, "profiles", sessionId);
    fs.mkdirSync(profileDir, { recursive: true });
    const launchAttempts: Array<{ withExtension: boolean; headless: boolean }> = [
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
        await evaluateExpression(targetWsUrl, "window.location.href");
        if (!child.pid) {
          throw new Error("Failed to launch Chrome process");
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

  async navigate(targetWsUrl: string, url: string): Promise<string> {
    let conn = await this.getConnection(targetWsUrl);
    try {
      await this.ensureEnabled(targetWsUrl);
      const loadPromise = Promise.race([
        conn.waitForEvent("Page.loadEventFired", 6000),
        conn.waitForEvent("Page.frameStoppedLoading", 6000),
      ]);
      await conn.send("Page.navigate", { url });
      try {
        await loadPromise;
      } catch {
        // fall back to reading location below
      }
      const result = await conn.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression: "window.location.href",
        returnByValue: true,
      });
      return result.result.value ?? url;
    } catch {
      this.dropConnection(targetWsUrl);
      conn = await this.getConnection(targetWsUrl);
      await this.ensureEnabled(targetWsUrl);
      const loadPromise = Promise.race([
        conn.waitForEvent("Page.loadEventFired", 6000),
        conn.waitForEvent("Page.frameStoppedLoading", 6000),
      ]);
      await conn.send("Page.navigate", { url });
      try {
        await loadPromise;
      } catch {
        // fall back to reading location below
      }
      const result = await conn.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression: "window.location.href",
        returnByValue: true,
      });
      return result.result.value ?? url;
    } finally {
      // keep pooled connection
    }
  }

  async interact(targetWsUrl: string, payload: InteractPayload): Promise<string> {
    let conn = await this.getConnection(targetWsUrl);
    const p = JSON.stringify(payload);
    const expression = `(async () => {
      const payload = ${p};
      if (payload.action === 'click') {
        const el = document.querySelector(payload.selector);
        if (!el) throw new Error('Selector not found');
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
        const el = document.querySelector(payload.selector);
        if (!el) throw new Error('Selector not found');
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
      throw new Error('Unsupported interact action');
    })()`;

    const execute = async (c: CdpClient): Promise<string> => {
      await this.ensureEnabled(targetWsUrl);
      const result = await c.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      const value = result.result.value ?? "";

      // After a click, wait briefly for any navigation it may trigger
      if (payload.action === "click" && value === "clicked") {
        try {
          await c.waitForEvent("Page.frameStoppedLoading", 500);
        } catch {
          // No navigation happened – that's fine for non-navigating clicks
        }
      }

      return value;
    };

    try {
      return await execute(conn);
    } catch {
      // retry once with a fresh connection
      this.dropConnection(targetWsUrl);
      conn = await this.getConnection(targetWsUrl);
      return await execute(conn);
    }
  }

  async getContent(targetWsUrl: string, options: PageContentOptions): Promise<PageContentResult> {
    const o = JSON.stringify(options);
    let conn = await this.getConnection(targetWsUrl);
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

    try {
      await this.ensureEnabled(targetWsUrl);
      const result = await conn.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      const content = result.result.value ?? "";
      return { mode: options.mode, content };
    } catch {
      this.dropConnection(targetWsUrl);
      conn = await this.getConnection(targetWsUrl);
      await this.ensureEnabled(targetWsUrl);
      const result = await conn.send<{ result: { value?: string } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      const content = result.result.value ?? "";
      return { mode: options.mode, content };
    }
  }

  async getInteractiveElements(
    targetWsUrl: string,
    options: InteractiveElementsOptions,
  ): Promise<InteractiveElementsResult> {
    const o = JSON.stringify(options);
    let conn = await this.getConnection(targetWsUrl);
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

      function buildSelector(el) {
        if (el.id) return '#' + CSS.escape(el.id);

        const name = el.getAttribute('name');
        if (name) {
          const tag = el.tagName.toLowerCase();
          const sel = tag + '[name="' + escapeAttr(name) + '"]';
          if (document.querySelectorAll(sel).length === 1) return sel;
        }

        const testId = el.getAttribute('data-testid') || el.getAttribute('data-test-id');
        if (testId) {
          const attr = el.hasAttribute('data-testid') ? 'data-testid' : 'data-test-id';
          const sel = '[' + attr + '="' + escapeAttr(testId) + '"]';
          if (document.querySelectorAll(sel).length === 1) return sel;
        }

        const ariaLabel = el.getAttribute('aria-label');
        if (ariaLabel) {
          const tag = el.tagName.toLowerCase();
          const sel = tag + '[aria-label="' + escapeAttr(ariaLabel) + '"]';
          if (document.querySelectorAll(sel).length === 1) return sel;
        }

        const parts = [];
        let current = el;
        while (current && current !== document.documentElement) {
          const tag = current.tagName.toLowerCase();
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

        const entry = {
          selector: buildSelector(el),
          role,
          tagName: el.tagName.toLowerCase(),
          text: getText(el),
          actions: getActions(role, el),
          visible: vis,
          enabled: isEnabled(el),
        };

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

    try {
      await this.ensureEnabled(targetWsUrl);
      const result = await conn.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      return extract(result);
    } catch {
      this.dropConnection(targetWsUrl);
      conn = await this.getConnection(targetWsUrl);
      await this.ensureEnabled(targetWsUrl);
      const result = await conn.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
        expression,
        returnByValue: true,
      });
      return extract(result);
    }
  }

  terminate(pid: number): void {
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

  async launch(sessionId: string): Promise<{ pid: number; cdpUrl: string; targetWsUrl: string }> {
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

  async navigate(cdpUrl: string, url: string): Promise<string> {
    const page = this.pages.get(cdpUrl);
    if (!page) throw new Error("mock page missing");
    page.url = url;
    page.title = url;
    page.text = `Content of ${url}`;
    page.html = `<html><body>${page.text}</body></html>`;
    return url;
  }

  async interact(_cdpUrl: string, payload: InteractPayload): Promise<string> {
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
