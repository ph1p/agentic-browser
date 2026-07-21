import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createAgenticBrowserCore, type AgenticBrowserCore } from "../cli/runtime.js";
import type { ErrorCode, InteractiveElementRole } from "../session/browser-controller.js";
import {
  compactInteractiveElementsResult,
  compactMemoryResults,
  compactPageContent,
} from "./response-helpers.js";
import { ElementRefRegistry } from "./element-refs.js";

function readPackageVersion(): string {
  try {
    const dir = dirname(fileURLToPath(import.meta.url));
    // Works from both src/ (dev) and dist/ (built)
    for (const rel of ["../../package.json", "../package.json"]) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, rel), "utf8")) as { version?: string };
        if (pkg.version) return pkg.version;
      } catch {
        // try next
      }
    }
  } catch {
    // fallback
  }
  return "0.0.0";
}

function classifyError(message: string): ErrorCode {
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
let activeSessionId: string | undefined;
const DEFAULT_MCP_MAX_CHARS: Record<string, number | undefined> = {
  summary: undefined,
  title: undefined,
  text: 8000,
  a11y: 10000,
  html: 4000,
};

function getCore(): AgenticBrowserCore {
  if (!core) {
    core = createAgenticBrowserCore();
  }
  return core;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

const refs = new ElementRefRegistry();

/**
 * Discover interactive elements, assign fresh refs for the session, and return
 * the compact agent-facing view (refs + role/text, no raw selectors). This is
 * the single "what can I see and do now" snapshot both browser_get_elements and
 * the post-interact page state share.
 */
async function snapshotElements(
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
  const { elements } = refs.assign(sessionId, result.elements);
  return compactInteractiveElementsResult(
    elements,
    { totalFound: result.totalFound, truncated: result.truncated },
    visibleOnly,
  );
}

/**
 * Resolve a session ID — auto-starts a session if none exists.
 * This means the LLM never has to call browser_start_session explicitly.
 */
async function resolveSession(sessionId?: string): Promise<string> {
  if (sessionId) return sessionId;
  if (activeSessionId) return activeSessionId;

  // Auto-start a session
  const session = await getCore().startSession();
  activeSessionId = session.sessionId;
  return activeSessionId;
}

const server = new McpServer({
  name: "agentic-browser",
  version: readPackageVersion(),
});

server.tool(
  "browser_start_session",
  "Start a new Chrome browser session (or return the existing one if healthy). Sessions auto-start when you call any other browser tool, so you rarely need to call this explicitly. Use this to force a fresh session after stopping the previous one.",
  {},
  async () => {
    const session = await getCore().startSession();
    activeSessionId = session.sessionId;
    // Strip authTokenRef — security credential the LLM never needs
    const { authTokenRef: _, ...compactSession } = session;
    return { content: [{ type: "text" as const, text: JSON.stringify(compactSession) }] };
  },
);

server.tool(
  "browser_navigate",
  "Navigate the browser to a URL. A session is auto-started if needed.",
  {
    url: z.string().describe("The URL to navigate to"),
    sessionId: z.string().optional().describe("Session ID (auto-resolved if omitted)"),
  },
  async ({ url, sessionId }) => {
    const sid = await resolveSession(sessionId);
    const result = await getCore().runCommand({
      sessionId: sid,
      commandId: genId("nav"),
      type: "navigate",
      payload: { url },
    });
    let cookieBanner: { dismissed: boolean; method?: string; detail?: string } | undefined;
    if (result.resultStatus === "success") {
      try {
        const dismissed = await getCore().dismissCookieBanner(sid);
        if (dismissed.dismissed) {
          cookieBanner = dismissed;
        }
      } catch {
        // Best-effort only.
      }
    }
    // Get current URL so the LLM knows where it landed
    let currentUrl: string | undefined;
    try {
      currentUrl = await getCore().getCurrentUrl(sid);
    } catch {
      // best-effort
    }
    // Return only the fields the LLM needs
    const compact: Record<string, unknown> = {
      resultStatus: result.resultStatus,
      resultMessage: result.resultMessage,
      currentUrl,
      cookieBanner,
    };
    if (result.resultStatus === "failed") {
      compact.errorCode = classifyError(result.resultMessage ?? "");
    }
    return { content: [{ type: "text" as const, text: JSON.stringify(compact) }] };
  },
);

server.tool(
  "browser_interact",
  'Interact with a page element or perform browser actions. Point at a target with `ref` (from browser_get_elements, e.g. "e3") — like clicking what you see. `selector` (CSS) still works as an escape hatch. Element actions: "click", "type", "press", "waitFor", "scroll", "hover", "select", "toggle". Navigation actions: "goBack", "goForward", "refresh". Dialog action: "dialog" (text="dismiss" to cancel, value="..." for prompt input). After an action that can change the page, the response includes a fresh `pageState` (new refs + summary) so you can see the result and pick your next action without a separate browser_get_elements call. A session is auto-started if needed.',
  {
    action: z
      .enum([
        "click",
        "type",
        "press",
        "waitFor",
        "scroll",
        "hover",
        "select",
        "toggle",
        "goBack",
        "goForward",
        "refresh",
        "dialog",
      ])
      .describe("The interaction type"),
    ref: z
      .string()
      .optional()
      .describe('Element ref from browser_get_elements (e.g. "e3") — preferred over selector'),
    selector: z.string().optional().describe("CSS selector for the target element (escape hatch)"),
    fallbackSelectors: z
      .array(z.string())
      .optional()
      .describe("Backup CSS selectors tried if the primary selector fails"),
    text: z
      .string()
      .optional()
      .describe('Text to type (for "type"), or "dismiss" to dismiss a dialog (for "dialog")'),
    key: z
      .string()
      .optional()
      .describe('Key to press (required for "press" action, e.g. "Enter", "Tab")'),
    value: z
      .string()
      .optional()
      .describe('Option value to select (for "select"), or prompt text (for "dialog")'),
    scrollX: z
      .number()
      .optional()
      .describe('Horizontal scroll delta in pixels (for "scroll" action)'),
    scrollY: z
      .number()
      .optional()
      .describe('Vertical scroll delta in pixels (for "scroll" action, positive = down)'),
    timeoutMs: z
      .number()
      .optional()
      .describe('Timeout in milliseconds (for "waitFor" action, default 4000)'),
    sessionId: z.string().optional().describe("Session ID (auto-resolved if omitted)"),
  },
  async ({
    action,
    ref,
    selector,
    fallbackSelectors,
    text,
    key,
    value,
    scrollX,
    scrollY,
    timeoutMs,
    sessionId,
  }) => {
    const sid = await resolveSession(sessionId);
    const payload: Record<string, unknown> = { action };

    // Resolve a ref to its stored selector target. An explicit selector wins if
    // both are given; a ref that no longer resolves is reported clearly rather
    // than silently acting on nothing.
    if (!selector && ref) {
      const resolved = refs.resolve(sid, ref);
      if (!resolved) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                resultStatus: "failed",
                resultMessage: `Unknown or stale ref "${ref}". Call browser_get_elements to refresh element refs.`,
                errorCode: "SELECTOR_NOT_FOUND" satisfies ErrorCode,
              }),
            },
          ],
        };
      }
      payload.selector = resolved.selector;
      if (resolved.fallbackSelectors) payload.fallbackSelectors = resolved.fallbackSelectors;
    } else {
      if (selector) payload.selector = selector;
      if (fallbackSelectors) payload.fallbackSelectors = fallbackSelectors;
    }

    if (text) payload.text = text;
    if (key) payload.key = key;
    if (value) payload.value = value;
    if (scrollX !== undefined) payload.scrollX = scrollX;
    if (scrollY !== undefined) payload.scrollY = scrollY;
    if (timeoutMs) payload.timeoutMs = timeoutMs;
    const result = await getCore().runCommand({
      sessionId: sid,
      commandId: genId("int"),
      type: "interact",
      payload,
    });
    // Get current URL — especially useful after clicks that trigger navigation
    let currentUrl: string | undefined;
    try {
      currentUrl = await getCore().getCurrentUrl(sid);
    } catch {
      // best-effort
    }
    // Return only the fields the LLM needs
    const compact: Record<string, unknown> = {
      resultStatus: result.resultStatus,
      resultMessage: result.resultMessage,
      currentUrl,
    };
    if (result.resultStatus === "failed") {
      compact.errorCode = classifyError(result.resultMessage ?? "");
    }

    // Interact-returns-state: after a successful action that can change what is
    // on the page, include a fresh snapshot (new refs + summary) so the agent
    // sees the result and can pick its next action without a separate call —
    // the way a person looks at the page again after acting. Pure inspection
    // ("hover", "waitFor") leaves the page unchanged, so we skip it there.
    const pageChanging = action !== "hover" && action !== "waitFor";
    if (result.resultStatus === "success" && pageChanging) {
      try {
        compact.pageState = await snapshotElements(sid, { visibleOnly: true, limit: 50 });
      } catch {
        // best-effort — the action already succeeded
      }
    }

    return { content: [{ type: "text" as const, text: JSON.stringify(compact) }] };
  },
);

server.tool(
  "browser_get_content",
  'Get the current page content. Modes: "summary" (recommended low-token overview with headings, actions, inputs, alerts, and iframe awareness), "text" (readable text), "a11y" (accessibility tree for deeper structure), "title" (page title only), "html" (raw HTML). A session is auto-started if needed.',
  {
    mode: z
      .enum(["title", "text", "html", "a11y", "summary"])
      .default("summary")
      .describe("Content extraction mode"),
    selector: z
      .string()
      .optional()
      .describe('CSS selector to scope content (e.g. "main", "#content")'),
    maxChars: z
      .number()
      .optional()
      .describe(
        "Maximum characters to return (default: 8000 for text, 10000 for a11y, 4000 for html, ignored for summary/title). Use a CSS selector to scope content instead of raising this limit.",
      ),
    sessionId: z.string().optional().describe("Session ID (auto-resolved if omitted)"),
  },
  async ({ mode, selector, maxChars, sessionId }) => {
    const sid = await resolveSession(sessionId);
    const effectiveMaxChars = maxChars ?? DEFAULT_MCP_MAX_CHARS[mode];
    const result = await getCore().getPageContent({
      sessionId: sid,
      mode,
      selector,
      maxChars: effectiveMaxChars,
    });
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(compactPageContent(result, effectiveMaxChars)),
        },
      ],
    };
  },
);

server.tool(
  "browser_get_elements",
  'Discover interactive elements on the current page (buttons, links, inputs, etc.). Each element gets a short ref like "e1" — pass that ref to browser_interact to act on it, the way you would point at something you see rather than describing its markup. Refs stay valid until the next browser_get_elements call or the next page-changing interaction. Actions per role: link/button/custom→click, input/textarea/contenteditable→click+type+press, select→click+select, checkbox/radio→toggle. A session is auto-started if needed.',
  {
    roles: z
      .array(
        z.enum([
          "link",
          "button",
          "input",
          "select",
          "textarea",
          "checkbox",
          "radio",
          "contenteditable",
          "custom",
        ]),
      )
      .optional()
      .describe("Filter by element roles (omit for all)"),
    visibleOnly: z.boolean().default(true).describe("Only return visible elements"),
    limit: z.number().default(50).describe("Maximum number of elements to return"),
    selector: z
      .string()
      .optional()
      .describe("CSS selector to scope element discovery to a subtree"),
    sessionId: z.string().optional().describe("Session ID (auto-resolved if omitted)"),
  },
  async ({ roles, visibleOnly, limit, selector, sessionId }) => {
    const sid = await resolveSession(sessionId);
    const snapshot = await snapshotElements(sid, { roles, visibleOnly, limit, selector });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(snapshot) }],
    };
  },
);

server.tool(
  "browser_search_memory",
  "Search task memory for previously learned selectors, selector aliases, and interaction patterns. Results include selectorHints (proven selectors) and selectorAliases (human-readable names mapped to selectors with fallbacks). Use this before interacting with a known site to reuse proven selectors instead of rediscovering them.",
  {
    taskIntent: z
      .string()
      .describe('What you want to do, e.g. "login:github.com" or "search:amazon.de"'),
    siteDomain: z.string().optional().describe("Domain to scope the search"),
    limit: z.number().default(5).describe("Maximum number of results"),
  },
  async ({ taskIntent, siteDomain, limit }) => {
    const result = getCore().searchMemory({ taskIntent, siteDomain, limit });
    return {
      content: [
        { type: "text" as const, text: JSON.stringify(compactMemoryResults(result.results)) },
      ],
    };
  },
);

server.tool(
  "browser_dismiss_cookies",
  "Dismiss cookie consent banners on the current page. Uses the accessibility tree first (most robust), then falls back to known CSS selectors and text-based button matching. Supports banners in English, German, French, Spanish, Italian, Dutch, and Portuguese. Call this after navigating to a new page. A session is auto-started if needed.",
  {
    sessionId: z.string().optional().describe("Session ID (auto-resolved if omitted)"),
  },
  async ({ sessionId }) => {
    const sid = await resolveSession(sessionId);
    const result = await getCore().dismissCookieBanner(sid);
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "browser_screenshot",
  "Capture a screenshot of the current page. Returns a base64-encoded image. Useful for visual verification, debugging element discovery failures, or when you need to see what the page looks like. A session is auto-started if needed.",
  {
    format: z
      .enum(["jpeg", "png"])
      .default("jpeg")
      .describe("Image format (jpeg is smaller, png is lossless)"),
    quality: z.number().optional().describe("JPEG quality 0-100 (default 60, ignored for png)"),
    fullPage: z
      .boolean()
      .default(false)
      .describe("Capture the full scrollable page instead of just the viewport"),
    sessionId: z.string().optional().describe("Session ID (auto-resolved if omitted)"),
  },
  async ({ format, quality, fullPage, sessionId }) => {
    const sid = await resolveSession(sessionId);
    const result = await getCore().screenshot(sid, { format, quality, fullPage });
    return {
      content: [
        {
          type: "image" as const,
          data: result.data,
          mimeType: result.mimeType,
        },
      ],
    };
  },
);

server.tool(
  "browser_stop_session",
  "Stop the browser session and terminate Chrome. The next browser tool call will auto-start a fresh session.",
  {
    sessionId: z.string().optional().describe("Session ID (uses active session if omitted)"),
  },
  async ({ sessionId }) => {
    const sid = sessionId ?? activeSessionId;
    if (!sid) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ok: true, message: "No active session to stop." }),
          },
        ],
      };
    }
    await getCore().stopSession(sid);
    refs.clear(sid);
    if (activeSessionId === sid) activeSessionId = undefined;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, stopped: sid }) }],
    };
  },
);

export async function main() {
  const transport = new StdioServerTransport();

  // MCP SDK uses property-based event handlers, not addEventListener
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = async () => {
    if (activeSessionId) {
      try {
        await getCore().stopSession(activeSessionId);
      } catch {
        // Best-effort cleanup
      }
      activeSessionId = undefined;
    }
    // Flush pending memory writes before exit
    try {
      getCore().context.memoryService.flushSync();
    } catch {
      // best-effort
    }
    // Clean up terminated sessions from the store
    try {
      getCore().sessions.cleanupSessions({ maxAgeDays: 0 });
    } catch {
      // best-effort
    }
  };

  await server.connect(transport);
}
