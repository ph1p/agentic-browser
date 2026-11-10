import crypto from "node:crypto";

import type { AppContext } from "../cli/app.js";
import {
  InteractPayloadSchema,
  type Command,
  type CommandType,
  type Session,
  type SessionEvent,
  type SessionStatus,
} from "../lib/domain-schemas.js";
import {
  type BrowserController,
  type DismissCookieBannerResult,
  type InteractPayload,
  type InteractiveElementsOptions,
  type PageContentOptions,
  type PageState,
  type TabInfo,
} from "./browser-controller.js";
import { assignRefs, REF_PATTERN, StaleRefError } from "./element-refs.js";
import { SessionStore, type StoredSessionRecord } from "./session-store.js";
import { assertNavigableUrl } from "./url-policy.js";
import { parseUrl } from "./memory-url.js";
import {
  cleanupSessions,
  isSessionAlive,
  type CleanupInput,
  type CleanupResult,
} from "./session-maintenance.js";

export type { CleanupResult } from "./session-maintenance.js";
import type { TaskStep } from "../memory/memory-schemas.js";
import { redactStepPayload } from "../memory/redact-step-payload.js";

interface CreateSessionInput {
  browser: "chrome";
}

interface ExecuteCommandInput {
  commandId: string;
  type: CommandType;
  payload: Record<string, unknown>;
  /** Task this step belongs to (e.g. "log in"); memory groups steps by it. */
  intent?: string;
}

export class SessionManager {
  private readonly store: SessionStore;

  constructor(
    private readonly ctx: AppContext,
    private readonly browser: BrowserController,
  ) {
    this.store = new SessionStore(this.ctx.config.dataDir);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    if (input.browser !== "chrome") {
      throw new Error("Only chrome is supported");
    }

    // If there's an existing active session, try to clean it up first
    const active = this.store.getActive();
    if (active && active.session.status !== "terminated") {
      // Check if the existing session is still alive
      if (await isSessionAlive(this.browser, active)) {
        // Return the healthy existing session instead of throwing
        return active.session;
      }
      // Dead session — force-terminate and clean up
      await this.forceTerminate(active);
    }

    const sessionId = crypto.randomUUID();
    const token = this.ctx.tokenService.issue(sessionId);
    const launched = this.ctx.config.cdpUrl
      ? await this.browser.connect(this.ctx.config.cdpUrl, { userAgent: this.ctx.config.userAgent })
      : await this.browser.launch(sessionId, {
          executablePath: this.ctx.config.browserExecutablePath,
          userProfileDir: this.ctx.config.userProfileDir,
          headless: this.ctx.config.headless,
          userAgent: this.ctx.config.userAgent,
        });

    const session: Session = {
      sessionId,
      status: "ready",
      browserType: "chrome",
      startedAt: new Date().toISOString(),
      authTokenRef: token,
    };

    this.store.save({
      session,
      cdpUrl: launched.cdpUrl,
      targetWsUrl: launched.targetWsUrl,
      pid: launched.pid,
    });

    this.recordEvent(sessionId, "lifecycle", "info", "Session started and ready");
    return session;
  }

  getSession(sessionId: string): Session {
    const record = this.mustGetRecord(sessionId);
    return record.session;
  }

  /** Return a healthy session, recovering automatically if needed. */
  async ensureSession(sessionId: string): Promise<StoredSessionRecord> {
    const record = this.store.get(sessionId);
    if (!record) {
      throw new Error("Session not found");
    }

    // Already ready — quick-verify the connection is alive
    if (record.session.status === "ready") {
      if (await isSessionAlive(this.browser, record)) {
        return record;
      }
      // Connection died silently — mark failed and fall through to recovery
      this.recordEvent(sessionId, "lifecycle", "warning", "Session connection lost, recovering");
    }

    // Attempt automatic recovery for non-terminated sessions
    if (record.session.status !== "terminated") {
      try {
        const recovered = await this.restartSession(sessionId);
        return this.mustGetRecord(recovered.sessionId);
      } catch (restartError) {
        this.recordEvent(
          sessionId,
          "lifecycle",
          "error",
          `Recovery failed: ${(restartError as Error).message}`,
        );
        throw new Error(
          `Session is not ready and recovery failed: ${(restartError as Error).message}`,
          { cause: restartError },
        );
      }
    }

    throw new Error("Session is terminated. Start a new session.");
  }

  async executeCommand(sessionId: string, rawInput: ExecuteCommandInput): Promise<Command> {
    const record = await this.ensureSession(sessionId);
    // A ref ("e3") stands for the selector stored by the last element listing.
    const input =
      rawInput.type === "interact"
        ? { ...rawInput, payload: await this.resolveRef(record, rawInput.payload) }
        : rawInput;
    const run = this.trackIntentRun(sessionId, record, input);

    const command: Command = {
      commandId: input.commandId,
      sessionId,
      type: input.type,
      payload: input.payload,
      submittedAt: new Date().toISOString(),
    };

    let resultMessage = "";
    let resultStatus: Command["resultStatus"] = "success";
    const memoryContext = this.buildMemoryContext(record, input, run.intent);
    const topInsight = this.ctx.memoryService
      .search({
        taskIntent: memoryContext.taskIntent,
        siteDomain: memoryContext.siteDomain,
        limit: 1,
      })
      .at(0);
    if (topInsight) {
      this.recordEvent(
        sessionId,
        "command",
        "info",
        `Memory candidate ${topInsight.insightId} score=${topInsight.score.toFixed(3)} freshness=${topInsight.freshness}`,
      );
    }

    try {
      if (input.type === "navigate") {
        const url = String(input.payload.url ?? "");
        if (!url) {
          throw new Error("navigate command requires payload.url");
        }
        assertNavigableUrl(url, { allowFileUrls: this.ctx.config.allowFileUrls });
        const finalUrl = await this.browser.navigate(record.targetWsUrl, url);
        this.store.setLastUrl(sessionId, finalUrl);
        resultMessage = `Navigated to ${finalUrl}`;
      } else if (input.type === "interact") {
        const parsedPayload = InteractPayloadSchema.safeParse(input.payload);
        if (!parsedPayload.success) {
          throw new Error(`Invalid interact payload: ${parsedPayload.error.message}`);
        }
        const interactionResult = await this.browser.interact(
          record.targetWsUrl,
          parsedPayload.data as InteractPayload,
        );
        resultMessage = `Interaction result: ${interactionResult}`;
        // Clicks and key presses can navigate; keep lastUrl (memory domain/path) current.
        const currentUrl = await this.browser
          .getCurrentUrl(record.targetWsUrl)
          .catch(() => undefined);
        if (currentUrl) this.store.setLastUrl(sessionId, currentUrl);
      } else if (input.type === "restart") {
        await this.restartSession(sessionId);
        resultMessage = "Session restarted";
      } else if (input.type === "terminate") {
        await this.terminateSession(sessionId);
        resultMessage = "Session terminated";
      } else {
        throw new Error(`Unsupported command type: ${String(input.type)}`);
      }
    } catch (error) {
      resultStatus = "failed";
      resultMessage = (error as Error).message;
    }

    const completed: Command = {
      ...command,
      completedAt: new Date().toISOString(),
      resultStatus,
      resultMessage,
    };

    this.recordEvent(
      sessionId,
      "command",
      resultStatus === "success" ? "info" : "warning",
      `Command ${input.type} -> ${resultStatus}`,
    );

    if (resultStatus === "success") {
      this.ctx.memoryService.recordSuccess({
        commandId: input.commandId,
        taskIntent: memoryContext.taskIntent,
        siteDomain: memoryContext.siteDomain,
        sitePathPattern: memoryContext.sitePathPattern,
        expectedOutcome: resultMessage,
        step: memoryContext.step,
        selector: memoryContext.selector,
        url: memoryContext.url,
        runId: run.runId,
      });
    } else {
      this.ctx.memoryService.recordFailure(
        {
          commandId: input.commandId,
          taskIntent: memoryContext.taskIntent,
          siteDomain: memoryContext.siteDomain,
          sitePathPattern: memoryContext.sitePathPattern,
          expectedOutcome: memoryContext.expectedOutcome,
          step: memoryContext.step,
          selector: memoryContext.selector,
          url: memoryContext.url,
        },
        resultMessage,
      );
    }

    return completed;
  }

  async getContent(sessionId: string, options: PageContentOptions) {
    const record = await this.ensureSession(sessionId);
    const result = await this.browser.getContent(record.targetWsUrl, options);

    if (options.mode === "summary" && result.structuredContent) {
      const sc = result.structuredContent as {
        url?: string;
        headings?: Array<{ text?: string } | string>;
        landmarks?: Array<{ role?: string } | string>;
      };
      const url = typeof sc.url === "string" ? sc.url : record.lastUrl;
      const parsed = parseUrl(url);
      const headingTexts = (sc.headings ?? []).map((h) =>
        typeof h === "string" ? h : (h.text ?? ""),
      );
      const landmarkTexts = (sc.landmarks ?? []).map((l) =>
        typeof l === "string" ? l : (l.role ?? ""),
      );
      this.ctx.memoryService.updateProfileFromContent(parsed.domain, parsed.pathPattern, {
        headings: headingTexts,
        landmarks: landmarkTexts,
      });
    }

    return result;
  }

  /** Lists interactive elements and assigns fresh refs (e1, e2, …) for this page. */
  async getInteractiveElements(sessionId: string, options: InteractiveElementsOptions) {
    const record = await this.ensureSession(sessionId);
    const result = await this.browser.getInteractiveElements(record.targetWsUrl, options);
    const { elements, byRef } = assignRefs(result.elements, options.frame);
    const url = await this.browser.getCurrentUrl(record.targetWsUrl).catch(() => undefined);
    this.store.update(sessionId, { refs: { url, byRef } });
    return { ...result, elements };
  }

  async screenshot(
    sessionId: string,
    options?: import("./browser-controller.js").ScreenshotOptions,
  ) {
    const record = await this.ensureSession(sessionId);
    return await this.browser.screenshot(record.targetWsUrl, options);
  }

  async getCurrentUrl(sessionId: string): Promise<string> {
    const record = await this.ensureSession(sessionId);
    return await this.browser.getCurrentUrl(record.targetWsUrl);
  }

  async getPageState(sessionId: string): Promise<PageState> {
    const record = await this.ensureSession(sessionId);
    return await this.browser.getPageState(record.targetWsUrl);
  }

  async listTabs(sessionId: string): Promise<Array<TabInfo & { active: boolean }>> {
    const record = await this.ensureSession(sessionId);
    const tabs = await this.browser.listTabs(record.cdpUrl);
    return tabs.map((tab) => ({ ...tab, active: tab.targetWsUrl === record.targetWsUrl }));
  }

  /** Points the session at another tab; later commands run there. */
  async switchTab(sessionId: string, tabId: string): Promise<TabInfo> {
    const record = await this.ensureSession(sessionId);
    const tab = (await this.browser.listTabs(record.cdpUrl)).find((t) => t.id === tabId);
    if (!tab) throw new Error(`Tab not found: ${tabId}`);
    await this.browser.activateTab(record.cdpUrl, tab.id);
    this.store.save({
      ...record,
      targetWsUrl: tab.targetWsUrl,
      lastUrl: tab.url || record.lastUrl,
    });
    this.recordEvent(sessionId, "lifecycle", "info", `Switched to tab ${tab.id}`);
    return tab;
  }

  async newTab(sessionId: string): Promise<TabInfo> {
    const record = await this.ensureSession(sessionId);
    const tab = await this.browser.openTab(record.cdpUrl);
    await this.browser.activateTab(record.cdpUrl, tab.id);
    this.store.save({ ...record, targetWsUrl: tab.targetWsUrl, lastUrl: tab.url });
    this.recordEvent(sessionId, "lifecycle", "info", `Opened tab ${tab.id}`);
    return tab;
  }

  /** Closes a tab; closing the active one moves the session to a remaining tab. */
  async closeTab(sessionId: string, tabId: string): Promise<{ closed: string; active: TabInfo }> {
    const record = await this.ensureSession(sessionId);
    const tabs = await this.browser.listTabs(record.cdpUrl);
    const target = tabs.find((t) => t.id === tabId);
    if (!target) throw new Error(`Tab not found: ${tabId}`);
    const remaining = tabs.filter((t) => t.id !== tabId);
    if (remaining.length === 0) {
      throw new Error("Refusing to close the last tab; use agent stop to end the session");
    }
    await this.browser.closeTab(record.cdpUrl, tabId);
    let active = tabs.find((t) => t.targetWsUrl === record.targetWsUrl) ?? remaining[0]!;
    if (target.targetWsUrl === record.targetWsUrl) {
      active = remaining[remaining.length - 1]!;
      await this.browser.activateTab(record.cdpUrl, active.id);
      this.store.save({ ...record, targetWsUrl: active.targetWsUrl, lastUrl: active.url });
    }
    this.recordEvent(sessionId, "lifecycle", "info", `Closed tab ${tabId}`);
    return { closed: tabId, active };
  }

  async dismissCookieBanner(sessionId: string): Promise<DismissCookieBannerResult> {
    const record = await this.ensureSession(sessionId);
    const result = await this.browser.dismissCookieBanner(record.targetWsUrl);

    const parsed = parseUrl(record.lastUrl);
    this.ctx.memoryService.updateProfileCookieBanner(parsed.domain, result);

    return result;
  }

  setStatus(status: SessionStatus, reason: string): Session {
    const active = this.store.getActive();
    if (!active) {
      throw new Error("No active session");
    }

    const session = {
      ...active.session,
      status,
      endedAt: status === "terminated" ? new Date().toISOString() : active.session.endedAt,
    };

    this.store.setSession(session);
    this.recordEvent(
      session.sessionId,
      "lifecycle",
      status === "failed" ? "error" : "warning",
      reason,
    );
    return session;
  }

  async terminateSession(sessionId: string): Promise<Session> {
    const record = this.mustGetRecord(sessionId);
    if (record.session.status !== "terminated") {
      if (this.browser.closeConnection) {
        try {
          this.browser.closeConnection(record.targetWsUrl);
        } catch {
          // ignore close failures
        }
      }
      if (record.pid === 0) {
        // Connected to the user's own browser: close only the tab we opened.
        const tabId = record.targetWsUrl.split("/").pop();
        if (tabId) await this.browser.closeTab(record.cdpUrl, tabId).catch(() => undefined);
      }
      this.browser.terminate(record.pid);
      this.ctx.tokenService.revoke(sessionId);
      const terminated: Session = {
        ...record.session,
        status: "terminated",
        endedAt: new Date().toISOString(),
      };
      this.store.setSession(terminated);
      this.store.clearActive(sessionId);
      this.recordEvent(sessionId, "lifecycle", "info", "Session terminated");
      return terminated;
    }
    return record.session;
  }

  async restartSession(sessionId: string): Promise<Session> {
    const record = this.mustGetRecord(sessionId);
    if (record.session.status === "terminated") {
      throw new Error("Session is terminated. Start a new session.");
    }

    // Clean up old connection and process regardless of status
    if (this.browser.closeConnection) {
      try {
        this.browser.closeConnection(record.targetWsUrl);
      } catch {
        // ignore close failures
      }
    }
    // Kill the old process if it's still around
    if (record.pid > 0) {
      try {
        this.browser.terminate(record.pid);
      } catch {
        // already dead — fine
      }
    }

    const relaunched = this.ctx.config.cdpUrl
      ? await this.browser.connect(this.ctx.config.cdpUrl, { userAgent: this.ctx.config.userAgent })
      : await this.browser.launch(sessionId, {
          executablePath: this.ctx.config.browserExecutablePath,
          userProfileDir: this.ctx.config.userProfileDir,
          headless: this.ctx.config.headless,
          userAgent: this.ctx.config.userAgent,
        });
    const restarted: Session = {
      ...record.session,
      status: "ready",
      endedAt: undefined,
    };

    // Refs and lastUrl belonged to the old page; the task run survives a
    // restart so an auto-retried step stays part of it.
    this.store.save({
      session: restarted,
      cdpUrl: relaunched.cdpUrl,
      targetWsUrl: relaunched.targetWsUrl,
      pid: relaunched.pid,
      intentRun: record.intentRun,
    });

    this.recordEvent(sessionId, "lifecycle", "info", "Session restarted");
    return restarted;
  }

  getAuthToken(sessionId: string): string {
    return this.mustGetRecord(sessionId).session.authTokenRef;
  }

  rotateAuthToken(sessionId: string): string {
    const record = this.mustGetRecord(sessionId);
    if (record.session.status === "terminated") {
      throw new Error("Session is terminated. Start a new session.");
    }
    this.ctx.tokenService.revoke(sessionId);
    const nextToken = this.ctx.tokenService.issue(sessionId);

    const updated: Session = {
      ...record.session,
      authTokenRef: nextToken,
    };
    this.store.setSession(updated);

    this.recordEvent(sessionId, "security", "info", "Session token rotated");
    return nextToken;
  }

  listEvents(sessionId: string, limit = 100): SessionEvent[] {
    return this.ctx.eventStore.list(sessionId, limit);
  }

  searchMemory(input: { taskIntent: string; siteDomain?: string; limit?: number }) {
    return this.ctx.memoryService.search(input);
  }

  inspectMemory(insightId: string) {
    return this.ctx.memoryService.inspect(insightId);
  }

  verifyMemory(insightId: string) {
    return this.ctx.memoryService.verify(insightId);
  }

  memoryStats() {
    return this.ctx.memoryService.stats();
  }

  /** Force-terminate a session record, cleaning up process, connection, and store. */
  cleanupSessions(input: CleanupInput): CleanupResult {
    return cleanupSessions(this.store, this.ctx.config.dataDir, input);
  }

  private async forceTerminate(record: StoredSessionRecord): Promise<void> {
    const { sessionId } = record.session;
    if (this.browser.closeConnection) {
      try {
        this.browser.closeConnection(record.targetWsUrl);
      } catch {
        // ignore
      }
    }
    if (record.pid > 0) {
      try {
        this.browser.terminate(record.pid);
      } catch {
        // already dead
      }
    }
    this.ctx.tokenService.revoke(sessionId);
    const terminated: Session = {
      ...record.session,
      status: "terminated",
      endedAt: new Date().toISOString(),
    };
    this.store.setSession(terminated);
    this.store.clearActive(sessionId);
    this.recordEvent(sessionId, "lifecycle", "warning", "Session force-terminated (stale)");
  }

  private mustGetRecord(sessionId: string): StoredSessionRecord {
    const record = this.store.get(sessionId);
    if (!record) {
      throw new Error("Session not found");
    }
    if (!record.targetWsUrl) {
      throw new Error("Session target is missing. Restart the session.");
    }

    // Re-seed the token service from the persisted record so bearer auth works
    // across CLI process restarts — but never for terminated sessions, whose
    // token was revoked (re-seeding would resurrect the revoked credential).
    if (record.session.status !== "terminated") {
      const seeded = this.ctx.tokenService.get(sessionId);
      if (!seeded || seeded !== record.session.authTokenRef) {
        this.ctx.tokenService.seed(sessionId, record.session.authTokenRef);
      }
    }

    return record;
  }

  private recordEvent(
    sessionId: string,
    category: SessionEvent["category"],
    severity: SessionEvent["severity"],
    message: string,
  ): void {
    this.ctx.eventStore.append({
      eventId: crypto.randomUUID(),
      sessionId,
      category,
      severity,
      message,
      createdAt: new Date().toISOString(),
    });
  }

  private buildMemoryContext(
    record: StoredSessionRecord,
    input: ExecuteCommandInput,
    runIntent: string | undefined,
  ): {
    taskIntent: string;
    siteDomain: string;
    sitePathPattern: string;
    expectedOutcome: string;
    step: TaskStep;
    selector?: string;
    url?: string;
  } {
    const selector =
      typeof input.payload.selector === "string" ? input.payload.selector : undefined;
    const inputUrl = typeof input.payload.url === "string" ? input.payload.url : record.lastUrl;
    const parsed = parseUrl(inputUrl);
    const action = typeof input.payload.action === "string" ? input.payload.action : undefined;

    const defaultIntent =
      input.type === "navigate"
        ? `navigate:${parsed.domain}`
        : input.type === "interact"
          ? `interact:${action ?? "action"}:${parsed.domain}`
          : `${input.type}:${parsed.domain}`;
    const taskIntent = runIntent ?? defaultIntent;
    const expectedOutcome =
      typeof input.payload.expectedOutcome === "string" && input.payload.expectedOutcome.trim()
        ? input.payload.expectedOutcome
        : `${input.type} command succeeds`;

    return {
      taskIntent,
      siteDomain: parsed.domain,
      sitePathPattern: parsed.pathPattern,
      expectedOutcome,
      step: {
        type:
          input.type === "navigate"
            ? "navigate"
            : input.type === "interact"
              ? "interact"
              : "assert",
        summary: input.type === "interact" ? `interact:${action ?? "unknown"}` : input.type,
        selector,
        payload: redactStepPayload(input.payload),
      },
      selector,
      url: inputUrl,
    };
  }

  private async resolveRef(
    record: StoredSessionRecord,
    payload: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const selector = typeof payload.selector === "string" ? payload.selector : undefined;
    const ref = selector ? REF_PATTERN.exec(selector)?.[1] : undefined;
    if (!selector || !ref) return payload;
    const { refs } = record;
    const stored = refs?.byRef[ref];
    const onSamePage =
      !refs?.url ||
      (await this.browser.getCurrentUrl(record.targetWsUrl).catch(() => undefined)) === refs.url;
    if (!stored || !onSamePage) throw new StaleRefError(selector);
    const extra = Array.isArray(payload.fallbackSelectors) ? payload.fallbackSelectors : [];
    return {
      ...payload,
      selector: stored.selector,
      fallbackSelectors: [...(stored.fallbackSelectors ?? []), ...extra],
      frame: payload.frame ?? stored.frame,
    };
  }

  /**
   * An intent starts a run (or continues it, if it is the current one). Later
   * commands without an intent join the run while they stay on its domain, so
   * callers need not repeat the intent on every step. An empty intent, or a
   * command on another domain, ends the run; such commands are their own run.
   */
  private trackIntentRun(
    sessionId: string,
    record: StoredSessionRecord,
    input: ExecuteCommandInput,
  ): { intent?: string; runId: string } {
    const current = record.intentRun;
    const intent = explicitIntent(input);
    const domain = parseUrl(
      typeof input.payload.url === "string" ? input.payload.url : record.lastUrl,
    ).domain;
    const ownRun = { runId: input.commandId };

    if (intent) {
      if (current?.intent === intent) return current;
      this.store.update(sessionId, { intentRun: { intent, runId: input.commandId, domain } });
      return { intent, ...ownRun };
    }
    const clears = input.intent !== undefined || input.payload.intent !== undefined;
    // An ad-hoc eval is a diagnostic, not a task step: it can't be replayed
    // (the expression is redacted), so it must not join the running recipe.
    if (input.payload.action === "evaluate" && !clears) return ownRun;
    if (current && !clears && current.domain === domain) return current;
    if (current) this.store.update(sessionId, { intentRun: undefined });
    return ownRun;
  }
}

/** The caller's task intent, if any. payload.intent is the older spelling, still honored. */
function explicitIntent(input: ExecuteCommandInput): string | undefined {
  const raw = input.intent ?? input.payload.intent;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}
