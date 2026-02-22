import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { CommandType } from "../../lib/domain-schemas.js";
import type { Runtime } from "../runtime.js";

const STATE_FILE_NAME = "agent-state.json";

interface AgentState {
  sessionId: string | null;
}

function stateFilePath(runtime: Runtime): string {
  return path.join(runtime.context.config.logDir, STATE_FILE_NAME);
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

export async function agentRun(
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
    return { ok: true, action: "run", ...first };
  } catch {
    await runtime.api.restartSession(sessionId);
    const second = await attempt();
    if (second.resultStatus === "failed") {
      throw new Error(second.resultMessage ?? "Command failed after retry");
    }
    return { ok: true, action: "run", ...second };
  }
}

export async function agentContent(
  runtime: Runtime,
  input: { mode: "title" | "text" | "html" | "a11y"; selector?: string },
) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);
  const result = await runtime.api.getContent(sessionId, {
    mode: input.mode,
    selector: input.selector,
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
