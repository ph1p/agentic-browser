import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { INTERACTIVE_ELEMENT_ROLES } from "../../session/browser-controller.js";
import { compactPageContent } from "../response-helpers.js";
import {
  classifyError,
  DEFAULT_MCP_MAX_CHARS,
  getCore,
  genId,
  snapshotElements,
  resolveSession,
  intentParam,
} from "../context.js";

export function registerPageTools(server: McpServer): void {
  server.tool(
    "browser_navigate",
    "Navigate the browser to a URL. A session is auto-started if needed.",
    {
      url: z.string().describe("The URL to navigate to"),
      intent: intentParam,
      sessionId: z.string().optional().describe("Session ID (auto-resolved if omitted)"),
    },
    async ({ url, intent, sessionId }) => {
      const sid = await resolveSession(sessionId);
      const result = await getCore().runCommand({
        sessionId: sid,
        commandId: genId("nav"),
        type: "navigate",
        payload: { url },
        intent,
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
        .array(z.enum(INTERACTIVE_ELEMENT_ROLES))
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
}
