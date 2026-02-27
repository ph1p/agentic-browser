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
    // Return only the fields the LLM needs
    const compact = { resultStatus: result.resultStatus, resultMessage: result.resultMessage };
    return { content: [{ type: "text" as const, text: JSON.stringify(compact) }] };
  },
);

server.tool(
  "browser_interact",
  'Interact with a page element or perform browser actions. Element actions: "click", "type", "press", "waitFor", "scroll", "hover", "select", "toggle". Navigation actions: "goBack" (browser back), "goForward" (browser forward), "refresh" (reload page). Dialog action: "dialog" (handle JS alert/confirm/prompt — use text="dismiss" to cancel, value="..." for prompt input). Fallback selectors are tried automatically if the primary selector fails. A session is auto-started if needed.',
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
    selector: z.string().optional().describe("CSS selector for the target element"),
    fallbackSelectors: z
      .array(z.string())
      .optional()
      .describe(
        "Backup CSS selectors tried if the primary selector fails (from browser_get_elements)",
      ),
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
    if (selector) payload.selector = selector;
    if (fallbackSelectors) payload.fallbackSelectors = fallbackSelectors;
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
    // Return only the fields the LLM needs
    const compact = { resultStatus: result.resultStatus, resultMessage: result.resultMessage };
    return { content: [{ type: "text" as const, text: JSON.stringify(compact) }] };
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
    maxChars: z
      .number()
      .optional()
      .describe(
        "Maximum characters to return (default: 12000 for text/a11y, 6000 for html, no cap for title). Use a CSS selector to scope content instead of raising this limit.",
      ),
    sessionId: z.string().optional().describe("Session ID (auto-resolved if omitted)"),
  },
  async ({ mode, selector, maxChars, sessionId }) => {
    const sid = await resolveSession(sessionId);
    const result = await getCore().getPageContent({ sessionId: sid, mode, selector });

    // Apply truncation defaults per mode (title is never truncated)
    const defaultMaxChars: Record<string, number | undefined> = {
      text: 12000,
      a11y: 12000,
      html: 6000,
      title: undefined,
    };
    const limit = maxChars ?? defaultMaxChars[mode];

    if (limit && typeof result.content === "string" && result.content.length > limit) {
      const originalLength = result.content.length;
      const truncatedContent =
        result.content.slice(0, limit) +
        `\n\n[Truncated — showing first ${limit} of ${originalLength} characters. Use a CSS selector to scope the content.]`;
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ ...result, content: truncatedContent, truncated: true }),
          },
        ],
      };
    }

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ ...result, truncated: false }) }],
    };
  },
);

server.tool(
  "browser_get_elements",
  "Discover all interactive elements on the current page (buttons, links, inputs, etc.). Returns CSS selectors and fallbackSelectors you can use with browser_interact. Pass fallbackSelectors to browser_interact for automatic retry when the primary selector breaks. Actions are derived from role: link/button/custom→click, input/textarea/contenteditable→click+type+press, select→click+select, checkbox/radio→toggle. A session is auto-started if needed.",
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

    // Strip redundant fields to reduce token usage
    const compactElements = result.elements.map((el) => {
      const compact: Record<string, unknown> = { ...el };
      // visible is always true when visibleOnly is true (the default)
      if (visibleOnly) delete compact.visible;
      // actions are derivable from role+inputType — documented in tool description
      delete compact.actions;
      // tagName is redundant with role
      delete compact.tagName;
      // ariaLabel duplicates text when they match
      if (compact.ariaLabel && compact.ariaLabel === compact.text) delete compact.ariaLabel;
      return compact;
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            elements: compactElements,
            totalFound: result.totalFound,
            truncated: result.truncated,
          }),
        },
      ],
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

    // Post-process to reduce token usage
    const compactResults = result.results.map((r) => {
      const compact: Record<string, unknown> = { ...r };
      // score is redundant — results are already sorted by relevance
      delete compact.score;
      // lastVerifiedAt is noise for the LLM
      delete compact.lastVerifiedAt;
      // Strip empty fallbackSelectors from aliases
      if (Array.isArray(compact.selectorAliases)) {
        compact.selectorAliases = (compact.selectorAliases as Record<string, unknown>[]).map(
          (alias) => {
            const compactAlias = { ...alias };
            if (
              Array.isArray(compactAlias.fallbackSelectors) &&
              compactAlias.fallbackSelectors.length === 0
            ) {
              delete compactAlias.fallbackSelectors;
            }
            return compactAlias;
          },
        );
      }
      return compact;
    });

    return {
      content: [{ type: "text" as const, text: JSON.stringify({ results: compactResults }) }],
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
