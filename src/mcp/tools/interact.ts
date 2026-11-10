import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { type AgenticBrowserCore } from "../../cli/runtime.js";
import { type ErrorCode } from "../../session/browser-controller.js";
import { StaleRefError } from "../../session/element-refs.js";
import {
  classifyError,
  getCore,
  genId,
  snapshotElements,
  resolveSession,
  intentParam,
} from "../context.js";

export function registerInteractTools(server: McpServer): void {
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
      selector: z
        .string()
        .optional()
        .describe("CSS selector for the target element (escape hatch)"),
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
      intent: intentParam,
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
      intent,
      sessionId,
    }) => {
      const sid = await resolveSession(sessionId);
      const payload: Record<string, unknown> = { action };

      // An explicit selector wins over a ref; the core resolves refs to their
      // stored selector and rejects ones taken on another page.
      const target = selector ?? ref;
      if (target) payload.selector = target;
      if (fallbackSelectors) payload.fallbackSelectors = fallbackSelectors;

      if (text) payload.text = text;
      if (key) payload.key = key;
      if (value) payload.value = value;
      if (scrollX !== undefined) payload.scrollX = scrollX;
      if (scrollY !== undefined) payload.scrollY = scrollY;
      if (timeoutMs) payload.timeoutMs = timeoutMs;
      let result: Awaited<ReturnType<AgenticBrowserCore["runCommand"]>>;
      try {
        result = await getCore().runCommand({
          sessionId: sid,
          commandId: genId("int"),
          type: "interact",
          payload,
          intent,
        });
      } catch (error) {
        if (!(error instanceof StaleRefError)) throw error;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                resultStatus: "failed",
                resultMessage: error.message,
                errorCode: "SELECTOR_NOT_FOUND" satisfies ErrorCode,
              }),
            },
          ],
        };
      }
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
}
