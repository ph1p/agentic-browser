import type { CommandType } from "../lib/domain-schemas.js";
import {
  ChromeCdpBrowserController,
  MockBrowserController,
  type BrowserController,
  type InteractiveElementRole,
  type InteractiveElementsOptions,
  type ScreenshotOptions,
} from "../session/browser-controller.js";
import { SessionManager } from "../session/session-manager.js";
import { ControlApi } from "../transport/control-api.js";
import { createAppContext, type AppContext } from "./app.js";

export interface AgenticBrowserCoreOptions {
  env?: NodeJS.ProcessEnv;
  browserController?: BrowserController;
}

export interface ExecuteCommandInput {
  sessionId: string;
  commandId?: string;
  type: CommandType;
  payload: Record<string, unknown>;
}

export class AgenticBrowserCore {
  readonly context: AppContext;
  readonly sessions: SessionManager;
  readonly api: ControlApi;
  private readonly browserController: BrowserController;
  private disposed = false;

  constructor(context: AppContext, browserController: BrowserController) {
    this.context = context;
    this.browserController = browserController;
    this.sessions = new SessionManager(context, browserController);
    this.api = new ControlApi(this.sessions);
  }

  /**
   * Release process-level resources (event store and memory store exit handlers,
   * controller timers). Flushes pending memory writes.
   * Does not terminate browser sessions. Idempotent.
   */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.browserController.dispose?.();
    this.context.eventStore.dispose();
    this.context.memoryService.dispose();
  }

  async startSession(input: { browser: "chrome" } = { browser: "chrome" }) {
    return await this.api.createSession(input);
  }

  getSession(sessionId: string) {
    return this.api.getSession(sessionId);
  }

  async runCommand(input: ExecuteCommandInput) {
    const commandId =
      input.commandId ?? `${input.type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    return await this.api.executeCommand(input.sessionId, {
      commandId,
      type: input.type,
      payload: input.payload,
    });
  }

  async getPageContent(input: {
    sessionId: string;
    mode: "title" | "text" | "html" | "a11y" | "summary";
    selector?: string;
    maxChars?: number;
  }) {
    return await this.api.getContent(input.sessionId, {
      mode: input.mode,
      selector: input.selector,
      maxChars: input.maxChars,
    });
  }

  async getInteractiveElements(input: {
    sessionId: string;
    roles?: InteractiveElementRole[];
    visibleOnly?: boolean;
    limit?: number;
    selector?: string;
    href?: string;
    text?: string;
    frame?: string;
  }) {
    return await this.api.getInteractiveElements(input.sessionId, {
      roles: input.roles,
      visibleOnly: input.visibleOnly,
      limit: input.limit,
      selector: input.selector,
      href: input.href,
      text: input.text,
      frame: input.frame,
    } satisfies InteractiveElementsOptions);
  }

  async dismissCookieBanner(sessionId: string) {
    return await this.api.dismissCookieBanner(sessionId);
  }

  async screenshot(sessionId: string, options?: ScreenshotOptions) {
    return await this.api.screenshot(sessionId, options);
  }

  async getCurrentUrl(sessionId: string) {
    return await this.api.getCurrentUrl(sessionId);
  }

  async getPageState(sessionId: string) {
    return await this.api.getPageState(sessionId);
  }

  async listTabs(sessionId: string) {
    return await this.api.listTabs(sessionId);
  }

  async switchTab(sessionId: string, tabId: string) {
    return await this.api.switchTab(sessionId, tabId);
  }

  async newTab(sessionId: string) {
    return await this.api.newTab(sessionId);
  }

  async closeTab(sessionId: string, tabId: string) {
    return await this.api.closeTab(sessionId, tabId);
  }

  async restartSession(sessionId: string) {
    return await this.api.restartSession(sessionId);
  }

  async stopSession(sessionId: string) {
    await this.api.terminateSession(sessionId);
  }

  rotateSessionToken(sessionId: string) {
    return this.api.rotateSessionToken(sessionId);
  }

  searchMemory(input: { taskIntent: string; siteDomain?: string; limit?: number }) {
    return this.api.searchMemory(input);
  }

  inspectMemory(insightId: string) {
    return this.api.inspectMemory(insightId);
  }

  verifyMemory(insightId: string) {
    return this.api.verifyMemory(insightId);
  }

  memoryStats() {
    return this.api.memoryStats();
  }
}

/** Alias – CLI commands receive a AgenticBrowserCore instance as their runtime. */
export type Runtime = AgenticBrowserCore;

export function createAgenticBrowserCore(
  options: AgenticBrowserCoreOptions = {},
): AgenticBrowserCore {
  const context = createAppContext(options.env);
  const controller =
    options.browserController ?? new ChromeCdpBrowserController(context.config.dataDir);
  return new AgenticBrowserCore(context, controller);
}

export function createMockAgenticBrowserCore(env: NodeJS.ProcessEnv): AgenticBrowserCore {
  const context = createAppContext(env);
  return new AgenticBrowserCore(context, new MockBrowserController());
}

export function createCliRuntime(): Runtime {
  return createAgenticBrowserCore();
}
