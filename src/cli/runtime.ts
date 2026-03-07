import type { CommandType } from "../lib/domain-schemas.js";
import {
  ChromeCdpBrowserController,
  MockBrowserController,
  type BrowserController,
  type InteractiveElementRole,
  type InteractiveElementsOptions,
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
  commandId: string;
  type: CommandType;
  payload: Record<string, unknown>;
}

export class AgenticBrowserCore {
  readonly context: AppContext;
  readonly sessions: SessionManager;
  readonly api: ControlApi;

  constructor(context: AppContext, browserController: BrowserController) {
    this.context = context;
    this.sessions = new SessionManager(context, browserController);
    this.api = new ControlApi(this.sessions, context.eventStore);
  }

  async startSession(input: { browser: "chrome" } = { browser: "chrome" }) {
    return await this.api.createSession(input);
  }

  getSession(sessionId: string) {
    return this.api.getSession(sessionId);
  }

  async runCommand(input: ExecuteCommandInput) {
    return await this.api.executeCommand(input.sessionId, {
      commandId: input.commandId,
      type: input.type,
      payload: input.payload,
    });
  }

  async getPageContent(input: {
    sessionId: string;
    mode: "title" | "text" | "html" | "a11y";
    selector?: string;
  }) {
    return await this.api.getContent(input.sessionId, {
      mode: input.mode,
      selector: input.selector,
    });
  }

  async getInteractiveElements(input: {
    sessionId: string;
    roles?: InteractiveElementRole[];
    visibleOnly?: boolean;
    limit?: number;
    selector?: string;
  }) {
    return await this.api.getInteractiveElements(input.sessionId, {
      roles: input.roles,
      visibleOnly: input.visibleOnly,
      limit: input.limit,
      selector: input.selector,
    } satisfies InteractiveElementsOptions);
  }

  async dismissCookieBanner(sessionId: string) {
    return await this.api.dismissCookieBanner(sessionId);
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
    options.browserController ?? new ChromeCdpBrowserController(context.config.logDir);
  return new AgenticBrowserCore(context, controller);
}

export function createMockAgenticBrowserCore(env: NodeJS.ProcessEnv): AgenticBrowserCore {
  const context = createAppContext(env);
  return new AgenticBrowserCore(context, new MockBrowserController());
}

export function createCliRuntime(): Runtime {
  return createAgenticBrowserCore();
}

export function createDefaultRuntime(): Runtime {
  const tempDir = `/tmp/agentic-browser-test-${Math.random().toString(16).slice(2)}`;
  return createMockAgenticBrowserCore({
    ...process.env,
    AGENTIC_BROWSER_LOG_DIR: tempDir,
  });
}
