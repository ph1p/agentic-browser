import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "../../lib/secure-fs.js";
import { discoverChrome } from "../chrome-launcher.js";
import { type CdpClient, CdpConnection, type CdpTarget } from "./cdp-connection.js";
import {
  createTarget,
  getFreePort,
  getJson,
  isProfileLocked,
  probePort,
  resolveDefaultProfileDir,
  waitForDebugger,
} from "./chrome-process.js";
import { type RuntimeContentPayload, normalizeRuntimeContentPayload } from "./content-limit.js";
import { dismissCookieBanner } from "./cookie-banner.js";
import { buildLocatorRuntimeExpression } from "./in-page-helpers.js";
import { getInteractiveElements } from "./interactive-elements.js";
import { getAccessibilityTree, getSummaryContent } from "./page-content.js";
import { type DialogInfo, type FrameScope, evaluateOnPage } from "./page-eval.js";
import { STEALTH_SCRIPT, initTarget } from "./page-init.js";
import type { PageOps } from "./page-ops.js";
import type {
  BrowserController,
  DismissCookieBannerResult,
  InteractPayload,
  InteractiveElementsOptions,
  InteractiveElementsResult,
  LaunchOptions,
  PageContentOptions,
  PageContentResult,
  PageState,
  ScreenshotOptions,
  ScreenshotResult,
  TabInfo,
} from "./types.js";
import { resolveFrameTarget, openFrameScope } from "./frame-scope.js";
import { hostPortOf, pageWsUrl } from "./browser-endpoint.js";
import {
  preparePointerTarget,
  prepareTypeTarget,
  armMainFrameNavigationWait,
  dispatchMouseClick,
  focusTarget,
  dispatchKeyPress,
} from "./input-dispatch.js";

/** Connection pool configuration */
export const CONNECTION_IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const CONNECTION_CLEANUP_INTERVAL_MS = 60_000; // 1 minute

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

export class ChromeCdpBrowserController implements BrowserController, PageOps {
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
    // The browser is already running; an open port is enough. Its HTTP endpoints
    // may be absent (chrome://inspect remote debugging), so don't wait on them.
    if (!(await probePort(port))) {
      throw new Error(`No browser is listening on ${cdpUrl}`);
    }
    const targetWsUrl = await createTarget(cdpUrl, { reuseExisting: false });
    const appliedUa = await initTarget(targetWsUrl, options?.userAgent);
    if (appliedUa) {
      this.userAgentOverrides.set(targetWsUrl, appliedUa);
    }
    return { pid: 0, cdpUrl, targetWsUrl };
  }

  async ensureEnabled(targetWsUrl: string): Promise<void> {
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
        // Headless defaults to an 800x600 window, which many sites treat as
        // mobile and collapse controls (e.g. Wikipedia hides its search box).
        args.push("--headless=new", "--window-size=1366,900");
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
        const targetWsUrl = await createTarget(cdpUrl, { reuseExisting: true });
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
  async withRetry<T>(
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

  /** Scope evaluation to the document of the iframe `frameLocator` points at. */
  async openFrameScope(
    conn: CdpClient,
    targetWsUrl: string,
    frameLocator: string,
  ): Promise<FrameScope> {
    return await openFrameScope(this.connectionFactory, conn, targetWsUrl, frameLocator);
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
    const target = await resolveFrameTarget(conn, payload);
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
                const local = await preparePointerTarget(client, scoped);
                const offset = await getOffset();
                const nav = await armMainFrameNavigationWait(conn);
                await dispatchMouseClick(conn, local.x + offset.x, local.y + offset.y);
                await nav.result;

                return "clicked";
              }

              if (scoped.action === "hover") {
                const local = await preparePointerTarget(client, scoped);
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
                await focusTarget(client, scoped);
                await dispatchKeyPress(conn, scoped.key);
                return "pressed";
              }

              const preparation = await prepareTypeTarget(client, scoped);
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
    let targets: CdpTarget[];
    try {
      targets = await getJson<CdpTarget[]>(`${cdpUrl}/json/list`);
    } catch {
      const { targetInfos } = await CdpConnection.sendBrowserCommand<{
        targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
      }>(hostPortOf(cdpUrl), "Target.getTargets");
      targets = targetInfos.map((info) => ({
        id: info.targetId,
        type: info.type,
        url: info.url,
        title: info.title,
        webSocketDebuggerUrl: pageWsUrl(cdpUrl, info.targetId),
      }));
    }
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
    const targetWsUrl = await createTarget(cdpUrl, { reuseExisting: false });
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
    const id = targetWsUrl.slice(targetWsUrl.lastIndexOf("/") + 1);
    return { id, url: "about:blank", title: "", targetWsUrl };
  }

  async activateTab(cdpUrl: string, tabId: string): Promise<void> {
    const response = await fetch(`${cdpUrl}/json/activate/${encodeURIComponent(tabId)}`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
    if (response?.ok) return;
    // No HTTP endpoints, or the tab is unknown: the browser socket decides.
    await CdpConnection.sendBrowserCommand(hostPortOf(cdpUrl), "Target.activateTarget", {
      targetId: tabId,
    }).catch(() => {
      throw new Error(`Tab not found: ${tabId}`);
    });
  }

  async closeTab(cdpUrl: string, tabId: string): Promise<void> {
    const tab = (await this.listTabs(cdpUrl)).find((candidate) => candidate.id === tabId);
    if (!tab) throw new Error(`Tab not found: ${tabId}`);
    this.dropConnection(tab.targetWsUrl);
    this.userAgentOverrides.delete(tab.targetWsUrl);
    const response = await fetch(`${cdpUrl}/json/close/${encodeURIComponent(tabId)}`, {
      signal: AbortSignal.timeout(5000),
    }).catch(() => undefined);
    if (response?.ok) return;
    await CdpConnection.sendBrowserCommand(hostPortOf(cdpUrl), "Target.closeTarget", {
      targetId: tabId,
    }).catch((error: unknown) => {
      throw new Error(`Unable to close tab ${tabId}: ${(error as Error).message}`);
    });
  }

  async getContent(targetWsUrl: string, options: PageContentOptions): Promise<PageContentResult> {
    if (options.mode === "summary") {
      return await getSummaryContent(this, targetWsUrl, options);
    }

    if (options.mode === "a11y") {
      const content = await getAccessibilityTree(this, targetWsUrl, options.selector);
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

  async getInteractiveElements(
    targetWsUrl: string,
    options: InteractiveElementsOptions,
  ): Promise<InteractiveElementsResult> {
    return await getInteractiveElements(this, targetWsUrl, options);
  }

  /** Best-effort cookie/consent banner dismissal; never blocks navigation. */
  async dismissCookieBanner(targetWsUrl: string): Promise<DismissCookieBannerResult> {
    return await dismissCookieBanner(this, targetWsUrl);
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
