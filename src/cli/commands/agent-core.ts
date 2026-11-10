import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { CommandType } from "../../lib/domain-schemas.js";
import { ensurePrivateDir, writePrivateFileSync } from "../../lib/secure-fs.js";
import {
  type DismissCookieBannerResult,
  type InteractPayload,
  type PageState,
  isConnectionError,
} from "../../session/browser-controller.js";
import type { Runtime } from "../runtime.js";

export const STATE_FILE_NAME = "agent-state.json";

export interface AgentState {
  sessionId: string | null;
}

export function stateFilePath(runtime: Runtime): string {
  return path.join(runtime.context.config.dataDir, STATE_FILE_NAME);
}

export function loadState(runtime: Runtime): AgentState {
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

export function saveState(runtime: Runtime, state: AgentState): void {
  const dir = path.dirname(stateFilePath(runtime));
  ensurePrivateDir(dir);
  writePrivateFileSync(stateFilePath(runtime), JSON.stringify(state, null, 2));
}

export function requireSessionId(runtime: Runtime): string {
  const state = loadState(runtime);
  if (!state.sessionId) {
    throw new Error("No active agent session. Run: agentic-browser agent start");
  }
  return state.sessionId;
}

export function nextCommandId(): string {
  return `cmd-${Date.now()}-${crypto.randomBytes(3).toString("hex")}`;
}

export async function ensureReady(runtime: Runtime, sessionId: string): Promise<void> {
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
export async function tryPageState(
  runtime: Runtime,
  sessionId: string,
): Promise<PageState | undefined> {
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
export function isRetryableFailure(message: string): boolean {
  if (isConnectionError(message)) return true;
  const lower = message.toLowerCase();
  return lower.includes("session") && (lower.includes("dead") || lower.includes("terminated"));
}

export async function executeAgentCommand(
  runtime: Runtime,
  input: { type: CommandType; payload: Record<string, unknown>; intent?: string },
) {
  const sessionId = requireSessionId(runtime);
  await ensureReady(runtime, sessionId);

  const attempt = () =>
    runtime.api.executeCommand(sessionId, {
      commandId: nextCommandId(),
      type: input.type,
      payload: input.payload,
      intent: input.intent,
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

export async function agentNavigate(runtime: Runtime, input: { url: string; intent?: string }) {
  const result = await executeAgentCommand(runtime, {
    type: "navigate",
    payload: { url: input.url },
    intent: input.intent,
  });
  let cookieBanner: DismissCookieBannerResult | undefined;

  if (result.resultStatus === "success") {
    try {
      const dismissed = await runtime.api.dismissCookieBanner(result.sessionId);
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

/** `intent` names the task this step belongs to; memory groups steps by it. */
export type AgentInteractInput = InteractPayload & { intent?: string };

/** `selector` may be a ref ("e3") from `agent elements`; the core resolves it. */
export async function agentInteract(runtime: Runtime, input: AgentInteractInput) {
  const { intent, ...payload } = input;
  const result = await executeAgentCommand(runtime, {
    type: "interact",
    payload: payload as unknown as Record<string, unknown>,
    intent,
  });
  // Clicks and key presses often navigate; report where the page ended up.
  const page = await tryPageState(runtime, result.sessionId);
  return { ok: true, action: input.action, ...result, url: page?.url };
}
