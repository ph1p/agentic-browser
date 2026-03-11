import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CommandType } from "../../lib/domain-schemas.js";
import type { InteractPayload } from "../../session/browser-controller.js";
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
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stateFilePath(runtime), JSON.stringify(state, null, 2));
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

export async function agentStatus(runtime: Runtime) {
  const sessionId = requireSessionId(runtime);
  const session = runtime.api.getSession(sessionId);
  return { ok: true, action: "status", ...session };
}

export async function agentStop(runtime: Runtime) {
  const sessionId = requireSessionId(runtime);
  await runtime.api.terminateSession(sessionId);
  saveState(runtime, { sessionId: null });
  return { ok: true, action: "stop", sessionId };
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

  try {
    const first = await attempt();
    if (first.resultStatus === "failed") {
      throw new Error(first.resultMessage ?? "Command failed");
    }
    return first;
  } catch {
    await runtime.api.restartSession(sessionId);
    const second = await attempt();
    if (second.resultStatus === "failed") {
      throw new Error(second.resultMessage ?? "Command failed after retry");
    }
    return second;
  }
}

export async function agentNavigate(runtime: Runtime, input: { url: string }) {
  const result = await executeAgentCommand(runtime, {
    type: "navigate",
    payload: { url: input.url },
  });
  let cookieBanner:
    | {
        dismissed: boolean;
        method?: "a11y" | "selector" | "text";
        detail?: string;
      }
    | undefined;

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

  return { ok: true, action: "navigate", ...result, cookieBanner };
}

export async function agentInteract(runtime: Runtime, input: InteractPayload) {
  const result = await executeAgentCommand(runtime, {
    type: "interact",
    payload: input as unknown as Record<string, unknown>,
  });
  return { ok: true, action: input.action, ...result };
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

export async function agentElements(
  runtime: Runtime,
  input: { roles?: string[]; visibleOnly?: boolean; limit?: number; selector?: string },
) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const result = await runtime.api.getInteractiveElements(sessionId, {
    roles: input.roles as import("../../session/browser-controller.js").InteractiveElementRole[],
    visibleOnly: input.visibleOnly,
    limit: input.limit,
    selector: input.selector,
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
