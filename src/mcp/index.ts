import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { createAgenticBrowserCore, type AgenticBrowserCore } from "../cli/runtime.js";

let core: AgenticBrowserCore;
let activeSessionId: string | undefined;

function getCore(): AgenticBrowserCore {
  if (!core) {
    core = createAgenticBrowserCore();
  }
  return core;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
  version: "0.1.0",
});

server.tool(
  "browser_start_session",
  "Start a new Chrome browser session (or return the existing one if healthy). Sessions auto-start when you call any other browser tool, so you rarely need to call this explicitly. Use this to force a fresh session after stopping the previous one.",
  {},
  async () => {
    const session = await getCore().startSession();
    activeSessionId = session.sessionId;
    return { content: [{ type: "text" as const, text: JSON.stringify(session) }] };
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
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "browser_interact",
  'Interact with a page element. Actions: "click" (click element), "type" (type text into input), "press" (press a keyboard key like Enter), "waitFor" (wait for element to appear), "scroll" (scroll page or element), "hover" (hover over element), "select" (pick option in <select>), "toggle" (toggle checkbox/radio/switch). A session is auto-started if needed.',
  {
    action: z
      .enum(["click", "type", "press", "waitFor", "scroll", "hover", "select", "toggle"])
      .describe("The interaction type"),
    selector: z.string().optional().describe("CSS selector for the target element"),
    text: z.string().optional().describe('Text to type (required for "type" action)'),
    key: z
      .string()
      .optional()
      .describe('Key to press (required for "press" action, e.g. "Enter", "Tab")'),
    value: z.string().optional().describe('Option value to select (required for "select" action)'),
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
  async ({ action, selector, text, key, value, scrollX, scrollY, timeoutMs, sessionId }) => {
    const sid = await resolveSession(sessionId);
    const payload: Record<string, unknown> = { action };
    if (selector) payload.selector = selector;
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
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "browser_get_content",
  'Get the current page content. Modes: "text" (readable text), "a11y" (accessibility tree — best for understanding page structure), "title" (page title only), "html" (raw HTML). Use "a11y" to see the full page hierarchy with roles, names, and states. A session is auto-started if needed.',
  {
    mode: z
      .enum(["title", "text", "html", "a11y"])
      .default("text")
      .describe("Content extraction mode"),
    selector: z
      .string()
      .optional()
      .describe('CSS selector to scope content (e.g. "main", "#content")'),
    sessionId: z.string().optional().describe("Session ID (auto-resolved if omitted)"),
  },
  async ({ mode, selector, sessionId }) => {
    const sid = await resolveSession(sessionId);
    const result = await getCore().getPageContent({ sessionId: sid, mode, selector });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "browser_get_elements",
  "Discover all interactive elements on the current page (buttons, links, inputs, etc.). Returns CSS selectors you can use with browser_interact. A session is auto-started if needed.",
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
    const result = await getCore().getInteractiveElements({
      sessionId: sid,
      roles,
      visibleOnly,
      limit,
      selector,
    });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
  },
);

server.tool(
  "browser_search_memory",
  "Search task memory for previously learned selectors and interaction patterns. Use this before interacting with a known site to reuse proven selectors instead of rediscovering them.",
  {
    taskIntent: z
      .string()
      .describe('What you want to do, e.g. "login:github.com" or "search:amazon.de"'),
    siteDomain: z.string().optional().describe("Domain to scope the search"),
    limit: z.number().default(5).describe("Maximum number of results"),
  },
  async ({ taskIntent, siteDomain, limit }) => {
    const result = getCore().searchMemory({ taskIntent, siteDomain, limit });
    return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
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
    if (activeSessionId === sid) activeSessionId = undefined;
    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ok: true, stopped: sid }) }],
    };
  },
);

export async function main() {
  const transport = new StdioServerTransport();

  transport.onclose = async () => {
    if (activeSessionId) {
      try {
        await getCore().stopSession(activeSessionId);
      } catch {
        // Best-effort cleanup
      }
      activeSessionId = undefined;
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
