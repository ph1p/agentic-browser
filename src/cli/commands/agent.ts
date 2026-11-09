import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CommandType } from "../../lib/domain-schemas.js";
import { ensurePrivateDir, writePrivateFileSync } from "../../lib/secure-fs.js";
import {
  isConnectionError,
  type DismissCookieBannerResult,
  type InteractiveElementRole,
  type InteractPayload,
  type PageState,
} from "../../session/browser-controller.js";
import type { Runtime } from "../runtime.js";

const STATE_FILE_NAME = "agent-state.json";

interface AgentState {
  sessionId: string | null;
}

function stateFilePath(runtime: Runtime): string {
  return path.join(runtime.context.config.dataDir, STATE_FILE_NAME);
}

function loadState(runtime: Runtime): AgentState {
  const filePath = stateFilePath(runtime);
  if (!fs.existsSync(filePath)) {
    return { sessionId: null };
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as AgentState;
  } catch {
    return { sessionId: null };
  }
}

function saveState(runtime: Runtime, state: AgentState): void {
  const dir = path.dirname(stateFilePath(runtime));
  ensurePrivateDir(dir);
  writePrivateFileSync(stateFilePath(runtime), JSON.stringify(state, null, 2));
}

function requireSessionId(runtime: Runtime): string {
  const state = loadState(runtime);
  if (!state.sessionId) {
    throw new Error("No active agent session. Run: agentic-browser agent start");
  }
  return state.sessionId;
}

function nextCommandId(): string {
  return `cmd-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

async function ensureReady(runtime: Runtime, sessionId: string): Promise<void> {
  const session = runtime.api.getSession(sessionId);
  if (session.status === "ready") return;
  const restarted = await runtime.api.restartSession(sessionId);
  if (restarted.status !== "ready") {
    throw new Error(`Session not ready after restart: ${restarted.status}`);
  }
}

export async function agentStart(runtime: Runtime) {
  const session = await runtime.api.createSession({ browser: "chrome" });
  saveState(runtime, { sessionId: session.sessionId });
  return { ok: true, action: "start", sessionId: session.sessionId };
}

/** Best-effort page state; never fails the command it decorates. */
async function tryPageState(runtime: Runtime, sessionId: string): Promise<PageState | undefined> {
  try {
    return await runtime.api.getPageState(sessionId);
  } catch {
    return undefined;
  }
}

export async function agentStatus(runtime: Runtime) {
  const sessionId = requireSessionId(runtime);
  const session = runtime.api.getSession(sessionId);
  const page = session.status === "ready" ? await tryPageState(runtime, sessionId) : undefined;
  return { ok: true, action: "status", ...session, url: page?.url, title: page?.title };
}

export async function agentStop(runtime: Runtime) {
  const sessionId = requireSessionId(runtime);
  await runtime.api.terminateSession(sessionId);
  saveState(runtime, { sessionId: null });
  return { ok: true, action: "stop", sessionId };
}

/** Only connection-level failures justify a restart + re-run. */
function isRetryableFailure(message: string): boolean {
  if (isConnectionError(message)) return true;
  const lower = message.toLowerCase();
  return lower.includes("session") && (lower.includes("dead") || lower.includes("terminated"));
}

async function executeAgentCommand(
  runtime: Runtime,
  input: { type: CommandType; payload: Record<string, unknown> },
) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);

  const attempt = () =>
    runtime.api.executeCommand(sessionId, {
      commandId: nextCommandId(),
      type: input.type,
      payload: input.payload,
    });

  const retryAfterRestart = async () => {
    await runtime.api.restartSession(sessionId);
    const second = await attempt();
    if (second.resultStatus === "failed") {
      throw new Error(second.resultMessage ?? "Command failed after retry");
    }
    return second;
  };

  const noRetry = input.type === "restart" || input.type === "terminate";

  let first: Awaited<ReturnType<typeof attempt>>;
  try {
    first = await attempt();
  } catch (error) {
    if (noRetry || !isRetryableFailure((error as Error).message)) throw error;
    return await retryAfterRestart();
  }
  if (first.resultStatus !== "failed") return first;
  const message = first.resultMessage ?? "Command failed";
  if (noRetry || !isRetryableFailure(message)) throw new Error(message);
  return await retryAfterRestart();
}

export async function agentNavigate(runtime: Runtime, input: { url: string }) {
  const result = await executeAgentCommand(runtime, {
    type: "navigate",
    payload: { url: input.url },
  });
  let cookieBanner: DismissCookieBannerResult | undefined;

  if (result.resultStatus === "success") {
    try {
      const sessionId = requireSessionId(runtime);
      const dismissed = await runtime.api.dismissCookieBanner(sessionId);
      if (dismissed.dismissed) {
        cookieBanner = dismissed;
      }
    } catch {
      // Best-effort only.
    }
  }

  const page = await tryPageState(runtime, result.sessionId);
  return { ok: true, action: "navigate", ...result, url: page?.url, cookieBanner };
}

export async function agentInteract(runtime: Runtime, input: InteractPayload) {
  const result = await executeAgentCommand(runtime, {
    type: "interact",
    payload: input as unknown as Record<string, unknown>,
  });
  // Clicks and key presses often navigate; report where the page ended up.
  const page = await tryPageState(runtime, result.sessionId);
  return { ok: true, action: input.action, ...result, url: page?.url };
}

const INTERACTION_RESULT_PREFIX = "Interaction result: ";

/** Evaluates a JavaScript expression in the page (or a frame) and returns its value. */
export async function agentEval(runtime: Runtime, input: { expression: string; frame?: string }) {
  const result = await agentInteract(runtime, {
    action: "evaluate",
    text: input.expression,
    frame: input.frame,
  });
  const raw = result.resultMessage?.startsWith(INTERACTION_RESULT_PREFIX)
    ? result.resultMessage.slice(INTERACTION_RESULT_PREFIX.length)
    : (result.resultMessage ?? "");
  let value: unknown = raw;
  try {
    value = raw === "" || raw === "undefined" ? null : JSON.parse(raw);
  } catch {
    // plain string result
  }
  return {
    ok: true,
    action: "eval",
    sessionId: result.sessionId,
    commandId: result.commandId,
    result: value,
    url: result.url,
  };
}

/** `/re/flags` = regex, `*` = glob, otherwise substring. */
export function matchesUrlPattern(url: string, pattern: string): boolean {
  const regex = /^\/(.+)\/([a-z]*)$/.exec(pattern);
  if (regex) return new RegExp(regex[1]!, regex[2]).test(url);
  if (pattern.includes("*")) {
    const escaped = pattern
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${escaped}$`).test(url);
  }
  return url.includes(pattern);
}

const WAIT_POLL_MS = 200;

export async function agentWait(
  runtime: Runtime,
  input: {
    selector?: string;
    text?: string;
    url?: string;
    load?: boolean;
    timeoutMs?: number;
    frame?: string;
  },
) {
  if (!input.selector && !input.text && !input.url && !input.load) {
    throw new Error("Nothing to wait for: pass a selector, --text, --url or --load");
  }
  if (input.selector && input.text) {
    throw new Error("Pass either a selector or --text, not both");
  }
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const timeoutMs = input.timeoutMs ?? 10_000;
  const started = Date.now();
  const remaining = () => timeoutMs - (Date.now() - started);

  const pollPage = async (done: (page: PageState) => boolean, describe: string) => {
    let last: PageState | undefined;
    for (;;) {
      // Navigations tear down the execution context mid-poll; just try again.
      last = (await tryPageState(runtime, sessionId)) ?? last;
      if (last && done(last)) return last;
      if (remaining() <= 0) {
        throw new Error(
          `wait timeout after ${timeoutMs}ms: ${describe} (current url: ${last?.url ?? "unknown"}, readyState: ${last?.readyState ?? "unknown"})`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, Math.min(WAIT_POLL_MS, remaining())));
    }
  };

  if (input.url) {
    const pattern = input.url;
    await pollPage(
      (page) => matchesUrlPattern(page.url, pattern),
      `url did not match "${pattern}"`,
    );
  }
  if (input.load) {
    await pollPage((page) => page.readyState === "complete", "page did not finish loading");
  }
  if (input.selector || input.text) {
    await agentInteract(runtime, {
      action: "waitFor",
      selector: input.selector ?? `text=${input.text}`,
      frame: input.frame,
      timeoutMs: Math.max(remaining(), 1),
    });
  }

  const page = await tryPageState(runtime, sessionId);
  return {
    ok: true,
    action: "wait",
    sessionId,
    elapsedMs: Date.now() - started,
    url: page?.url,
    title: page?.title,
    readyState: page?.readyState,
  };
}

/** Accepts a full tab id or a unique prefix of one. */
async function resolveTabId(runtime: Runtime, sessionId: string, idOrPrefix: string) {
  const tabs = await runtime.api.listTabs(sessionId);
  const exact = tabs.find((tab) => tab.id === idOrPrefix);
  if (exact) return exact.id;
  const matches = tabs.filter((tab) => tab.id.startsWith(idOrPrefix));
  if (matches.length === 1) return matches[0]!.id;
  if (matches.length > 1) throw new Error(`Ambiguous tab id prefix: ${idOrPrefix}`);
  throw new Error(`Tab not found: ${idOrPrefix}`);
}

export async function agentTabs(runtime: Runtime) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const tabs = await runtime.api.listTabs(sessionId);
  return {
    ok: true,
    action: "tabs",
    sessionId,
    tabs: tabs.map(({ id, url, title, active }) => ({ id, url, title, active })),
  };
}

export async function agentTabSwitch(runtime: Runtime, input: { id: string }) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const tab = await runtime.api.switchTab(
    sessionId,
    await resolveTabId(runtime, sessionId, input.id),
  );
  return { ok: true, action: "tab", sessionId, id: tab.id, url: tab.url, title: tab.title };
}

export async function agentTabNew(runtime: Runtime, input: { url?: string }) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const tab = await runtime.api.newTab(sessionId);
  if (!input.url) {
    return { ok: true, action: "tab-new", sessionId, id: tab.id, url: tab.url };
  }
  const navigated = await agentNavigate(runtime, { url: input.url });
  return { ...navigated, action: "tab-new", id: tab.id };
}

export async function agentTabClose(runtime: Runtime, input: { id: string }) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const result = await runtime.api.closeTab(
    sessionId,
    await resolveTabId(runtime, sessionId, input.id),
  );
  return {
    ok: true,
    action: "tab-close",
    sessionId,
    closed: result.closed,
    active: { id: result.active.id, url: result.active.url, title: result.active.title },
  };
}

export async function agentRestart(runtime: Runtime) {
  const result = await executeAgentCommand(runtime, {
    type: "restart",
    payload: {},
  });
  return { ok: true, action: "restart", ...result };
}

export async function agentTerminate(runtime: Runtime) {
  const result = await executeAgentCommand(runtime, {
    type: "terminate",
    payload: {},
  });
  saveState(runtime, { sessionId: null });
  return { ok: true, action: "terminate", ...result };
}

export async function agentDismissCookies(runtime: Runtime) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const result = await runtime.api.dismissCookieBanner(sessionId);
  return { ok: true, action: "cookies", sessionId, ...result };
}

export async function agentContent(
  runtime: Runtime,
  input: {
    mode: "title" | "text" | "html" | "a11y" | "summary";
    selector?: string;
    maxChars?: number;
  },
) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const result = await runtime.api.getContent(sessionId, {
    mode: input.mode,
    selector: input.selector,
    maxChars: input.maxChars,
  });
  return { ok: true, action: "content", ...result };
}

export async function agentScreenshot(
  runtime: Runtime,
  input: { out?: string; format?: "jpeg" | "png"; quality?: number; fullPage?: boolean },
) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const format = input.format ?? "png";
  const result = await runtime.api.screenshot(sessionId, {
    format,
    quality: input.quality,
    fullPage: input.fullPage,
  });
  const ext = format === "png" ? "png" : "jpg";
  let filePath: string;
  if (input.out) {
    filePath = path.resolve(input.out);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  } else {
    // Default location lives under the data dir, so keep it private like the rest of it.
    const dir = path.join(runtime.context.config.dataDir, "screenshots");
    ensurePrivateDir(dir);
    filePath = path.join(dir, `${sessionId}-${Date.now()}.${ext}`);
  }
  const bytes = Buffer.from(result.data, "base64");
  fs.writeFileSync(filePath, bytes, { mode: 0o600 });
  return {
    ok: true,
    action: "screenshot",
    sessionId,
    path: filePath,
    mimeType: result.mimeType,
    bytes: bytes.length,
  };
}

export async function agentElements(
  runtime: Runtime,
  input: {
    roles?: string[];
    visibleOnly?: boolean;
    limit?: number;
    selector?: string;
    href?: string;
    text?: string;
    frame?: string;
  },
) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const result = await runtime.api.getInteractiveElements(sessionId, {
    roles: input.roles as InteractiveElementRole[],
    visibleOnly: input.visibleOnly,
    limit: input.limit,
    selector: input.selector,
    href: input.href,
    text: input.text,
    frame: input.frame,
  });
  return { ok: true, action: "elements", ...result };
}

export async function agentMemorySearch(
  runtime: Runtime,
  input: { taskIntent: string; siteDomain?: string; limit?: number },
) {
  const result = runtime.api.searchMemory(input);
  return { ok: true, action: "memory-search", ...result };
}

export async function agentCleanup(
  runtime: Runtime,
  input: { maxAgeDays?: number; dryRun?: boolean },
) {
  const result = runtime.api.cleanupSessions(input);
  return { ok: true, action: "cleanup", ...result };
}
