import { z } from "zod";
import { createAgenticBrowserCore, type AgenticBrowserCore } from "../cli/runtime.js";
import { type ErrorCode, type InteractiveElementRole } from "../session/browser-controller.js";
import { compactInteractiveElementsResult } from "./response-helpers.js";
import { createSessionResolver } from "./session-resolver.js";

export function classifyError(message: string): ErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes("not found") || lower.includes("no element")) return "SELECTOR_NOT_FOUND";
  if (lower.includes("covered") || lower.includes("overlay")) return "ELEMENT_COVERED";
  if (lower.includes("not editable") || lower.includes("readonly")) return "ELEMENT_NOT_EDITABLE";
  if (lower.includes("navigation failed")) return "NAVIGATION_FAILED";
  if (lower.includes("navigation") && lower.includes("timeout")) return "NAVIGATION_TIMEOUT";
  if (lower.includes("cdp connection") || lower.includes("websocket")) return "CDP_DISCONNECTED";
  if (lower.includes("session") && (lower.includes("dead") || lower.includes("terminated")))
    return "SESSION_DEAD";
  if (lower.includes("dialog")) return "DIALOG_BLOCKING";
  if (lower.includes("timeout")) return "TIMEOUT";
  return "UNKNOWN";
}

let core: AgenticBrowserCore;
export const sessionResolver = createSessionResolver(() => getCore().startSession());
export const DEFAULT_MCP_MAX_CHARS: Record<string, number | undefined> = {
  summary: undefined,
  title: undefined,
  text: 8000,
  a11y: 10000,
  html: 4000,
};

export function getCore(): AgenticBrowserCore {
  if (!core) {
    core = createAgenticBrowserCore();
  }
  return core;
}

export function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Discover interactive elements, assign fresh refs for the session, and return
 * the compact agent-facing view (refs + role/text, no raw selectors). This is
 * the single "what can I see and do now" snapshot both browser_get_elements and
 * the post-interact page state share.
 */
export async function snapshotElements(
  sessionId: string,
  opts: {
    visibleOnly?: boolean;
    limit?: number;
    selector?: string;
    roles?: InteractiveElementRole[];
  } = {},
): Promise<Record<string, unknown>> {
  const visibleOnly = opts.visibleOnly ?? true;
  const result = await getCore().getInteractiveElements({
    sessionId,
    visibleOnly,
    limit: opts.limit ?? 50,
    selector: opts.selector,
    roles: opts.roles,
  });
  return compactInteractiveElementsResult(
    result.elements,
    { totalFound: result.totalFound, truncated: result.truncated },
    visibleOnly,
  );
}

/**
 * Resolve a session ID — auto-starts a session if none exists.
 * This means the LLM never has to call browser_start_session explicitly.
 */
export async function resolveSession(sessionId?: string): Promise<string> {
  return sessionResolver.resolve(sessionId);
}

export const intentParam = z
  .string()
  .optional()
  .describe(
    'Task this step belongs to, in your own words (e.g. "log in", "search products"). Steps sharing an intent are remembered together and returned as a recipe by browser_search_memory. Later steps on the same site without an intent join the task; pass "" to end it',
  );
