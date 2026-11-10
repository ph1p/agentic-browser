import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { sessionResolver, getCore } from "../context.js";

export function registerSessionTools(server: McpServer): void {
  server.tool(
    "browser_start_session",
    "Start a new Chrome browser session (or return the existing one if healthy). Sessions auto-start when you call any other browser tool, so you rarely need to call this explicitly. Use this to force a fresh session after stopping the previous one.",
    {},
    async () => {
      const session = await getCore().startSession();
      sessionResolver.set(session.sessionId);
      // Strip authTokenRef — security credential the LLM never needs
      const { authTokenRef: _, ...compactSession } = session;
      return { content: [{ type: "text" as const, text: JSON.stringify(compactSession) }] };
    },
  );

  server.tool(
    "browser_stop_session",
    "Stop the browser session and terminate Chrome. The next browser tool call will auto-start a fresh session.",
    {
      sessionId: z.string().optional().describe("Session ID (uses active session if omitted)"),
    },
    async ({ sessionId }) => {
      const sid = sessionId ?? sessionResolver.current();
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
      if (sessionResolver.current() === sid) sessionResolver.clear();
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ok: true, stopped: sid }) }],
      };
    },
  );
}
