import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { URL } from "node:url";

import type { AppContext } from "../cli/app.js";
import type {
  Command,
  CommandType,
  Session,
  SessionEvent,
  SessionStatus,
} from "../lib/domain-schemas.js";
import {
  type BrowserController,
  type DismissCookieBannerResult,
  type InteractPayload,
  type InteractiveElementsOptions,
  type PageContentOptions,
} from "./browser-controller.js";
import { SessionStore, type StoredSessionRecord } from "./session-store.js";
import type { TaskStep } from "../memory/memory-schemas.js";

interface CreateSessionInput {
  browser: "chrome";
}

interface ExecuteCommandInput {
  commandId: string;
  type: CommandType;
  payload: Record<string, unknown>;
}

interface CleanupInput {
  maxAgeDays?: number;
  dryRun?: boolean;
}

interface CleanupResult {
  removedSessionIds: string[];
  removedProfileDirs: string[];
  keptActiveSessionId?: string;
  dryRun: boolean;
}

export class SessionManager {
  private readonly store: SessionStore;

  constructor(
    private readonly ctx: AppContext,
    private readonly browser: BrowserController,
  ) {
    this.store = new SessionStore(this.ctx.config.logDir);
  }

  async createSession(input: CreateSessionInput): Promise<Session> {
    if (input.browser !== "chrome") {
      throw new Error("Only chrome is supported");
    }

    // If there's an existing active session, try to clean it up first
    const active = this.store.getActive();
    if (active && active.session.status !== "terminated") {
      // Check if the existing session is still alive
      if (await this.isSessionAlive(active)) {
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
      if (await this.isSessionAlive(record)) {
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
        );
      }
    }

    throw new Error("Session is terminated. Start a new session.");
  }

  async executeCommand(sessionId: string, input: ExecuteCommandInput): Promise<Command> {
    const record = await this.ensureSession(sessionId);

    const command: Command = {
      commandId: input.commandId,
      sessionId,
      type: input.type,
      payload: input.payload,
      submittedAt: new Date().toISOString(),
    };

    let resultMessage = "";
    let resultStatus: Command["resultStatus"] = "success";
    const memoryContext = this.buildMemoryContext(record, input);
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
        const finalUrl = await this.browser.navigate(record.targetWsUrl, url);
        this.store.setLastUrl(sessionId, finalUrl);
        resultMessage = `Navigated to ${finalUrl}`;
      } else if (input.type === "interact") {
        const interactionResult = await this.browser.interact(
          record.targetWsUrl,
          input.payload as unknown as InteractPayload,
        );
        resultMessage = `Interaction result: ${interactionResult}`;
      } else if (input.type === "restart") {
        await this.restartSession(sessionId);
        resultMessage = "Session restarted";
      } else if (input.type === "terminate") {
        await this.terminateSession(sessionId);
        resultMessage = "Session terminated";
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
    return await this.browser.getContent(record.targetWsUrl, options);
  }

  async getInteractiveElements(sessionId: string, options: InteractiveElementsOptions) {
    const record = await this.ensureSession(sessionId);
    return await this.browser.getInteractiveElements(record.targetWsUrl, options);
  }

  async dismissCookieBanner(sessionId: string): Promise<DismissCookieBannerResult> {
    const record = await this.ensureSession(sessionId);
    return await this.browser.dismissCookieBanner(record.targetWsUrl);
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

    this.store.save({
      session: restarted,
      cdpUrl: relaunched.cdpUrl,
      targetWsUrl: relaunched.targetWsUrl,
      pid: relaunched.pid,
    });

    this.recordEvent(sessionId, "lifecycle", "info", "Session restarted");
    return restarted;
  }

  getAuthToken(sessionId: string): string {
    return this.mustGetRecord(sessionId).session.authTokenRef;
  }

  rotateAuthToken(sessionId: string): string {
    const record = this.mustGetRecord(sessionId);
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

  cleanupSessions(input: CleanupInput): CleanupResult {
    const maxAgeDays = input.maxAgeDays ?? 7;
    if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) {
      throw new Error("maxAgeDays must be a non-negative number");
    }

    const dryRun = input.dryRun ?? false;
    const now = Date.now();
    const cutoffMs = now - maxAgeDays * 24 * 60 * 60 * 1000;
    const active = this.store.getActive();
    const all = this.store.list();

    const removedSessionIds: string[] = [];
    const keep: StoredSessionRecord[] = [];

    for (const record of all) {
      const isActive = active?.session.sessionId === record.session.sessionId;
      if (isActive) {
        keep.push(record);
        continue;
      }

      if (record.session.status !== "terminated") {
        keep.push(record);
        continue;
      }

      const endedAt = record.session.endedAt ? Date.parse(record.session.endedAt) : Number.NaN;
      if (Number.isNaN(endedAt) || endedAt > cutoffMs) {
        keep.push(record);
        continue;
      }

      removedSessionIds.push(record.session.sessionId);
    }

    const keepIds = new Set(keep.map((record) => record.session.sessionId));
    const profilesDir = path.join(this.ctx.config.logDir, "profiles");
    const removedProfileDirs: string[] = [];

    if (fs.existsSync(profilesDir)) {
      for (const entry of fs.readdirSync(profilesDir)) {
        const fullPath = path.join(profilesDir, entry);
        if (!fs.statSync(fullPath).isDirectory()) {
          continue;
        }
        if (keepIds.has(entry)) {
          continue;
        }
        removedProfileDirs.push(fullPath);
      }
    }

    if (!dryRun) {
      this.store.replaceSessions(keep, active?.session.sessionId);
      for (const profilePath of removedProfileDirs) {
        fs.rmSync(profilePath, { recursive: true, force: true });
      }
    }

    return {
      removedSessionIds,
      removedProfileDirs,
      keptActiveSessionId: active?.session.sessionId,
      dryRun,
    };
  }

  /** Quick health check — probe the CDP connection with a lightweight evaluate. */
  private async isSessionAlive(record: StoredSessionRecord): Promise<boolean> {
    if (!record.targetWsUrl) return false;
    if (record.pid > 0) {
      try {
        process.kill(record.pid, 0); // signal 0 = existence check
      } catch (err: unknown) {
        // EPERM means the process exists but we can't signal it — still alive
        if ((err as NodeJS.ErrnoException).code === "EPERM") {
          // fall through to CDP check
        } else {
          return false; // ESRCH = process is gone
        }
      }
    }
    try {
      await this.browser.getContent(record.targetWsUrl, { mode: "title" });
      return true;
    } catch {
      return false;
    }
  }

  /** Force-terminate a session record, cleaning up process, connection, and store. */
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

    const seeded = this.ctx.tokenService.get(sessionId);
    if (!seeded || seeded !== record.session.authTokenRef) {
      this.ctx.tokenService.seed(sessionId, record.session.authTokenRef);
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
    const parsed = this.parseUrl(inputUrl);
    const action = typeof input.payload.action === "string" ? input.payload.action : undefined;

    const defaultIntent =
      input.type === "navigate"
        ? `navigate:${parsed.domain}`
        : input.type === "interact"
          ? `interact:${action ?? "action"}:${parsed.domain}`
          : `${input.type}:${parsed.domain}`;
    const taskIntent =
      typeof input.payload.intent === "string" && input.payload.intent.trim()
        ? input.payload.intent
        : defaultIntent;
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
        payload: input.payload,
      },
      selector,
      url: inputUrl,
    };
  }

  private parseUrl(rawUrl?: string): { domain: string; pathPattern: string } {
    if (!rawUrl) {
      return { domain: "unknown", pathPattern: "/" };
    }
    try {
      const parsed = new URL(rawUrl);
      const firstSegment = parsed.pathname.split("/").filter(Boolean)[0];
      const pathPattern = firstSegment ? `/${firstSegment}/*` : "/";
      return { domain: parsed.hostname.toLowerCase(), pathPattern };
    } catch {
      return { domain: "unknown", pathPattern: "/" };
    }
  }
}
