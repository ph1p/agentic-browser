import fs from "node:fs";
import path from "node:path";
import { ensurePrivateDir } from "../../lib/secure-fs.js";
import { type InteractiveElementRole } from "../../session/browser-controller.js";
import type { Runtime } from "../runtime.js";
import { saveState, requireSessionId, ensureReady, executeAgentCommand } from "./agent-core.js";

export {
  agentInteract,
  agentNavigate,
  agentStart,
  agentStatus,
  agentStop,
  type AgentInteractInput,
} from "./agent-core.js";
export { agentEval, agentWait, matchesUrlPattern } from "./agent-wait.js";
export { agentTabClose, agentTabNew, agentTabs, agentTabSwitch } from "./agent-tabs.js";

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
  // Summary mode carries everything in structuredContent; skip the empty text.
  const { content, ...rest } = result;
  return { ok: true, action: "content", ...rest, ...(content ? { content } : {}) };
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
    roles?: InteractiveElementRole[];
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
    roles: input.roles,
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
