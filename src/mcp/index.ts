import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readPackageVersion } from "../lib/package-version.js";
import { getCore, sessionResolver } from "./context.js";
import { registerSessionTools } from "./tools/session.js";
import { registerPageTools } from "./tools/page.js";
import { registerInteractTools } from "./tools/interact.js";
import { registerMemoryTools } from "./tools/memory.js";

const server = new McpServer({
  name: "agentic-browser",
  version: readPackageVersion(),
});

registerSessionTools(server);
registerPageTools(server);
registerInteractTools(server);
registerMemoryTools(server);

export async function main() {
  const transport = new StdioServerTransport();

  // MCP SDK uses property-based event handlers, not addEventListener
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  transport.onclose = async () => {
    const activeId = sessionResolver.current();
    if (activeId) {
      try {
        await getCore().stopSession(activeId);
      } catch {
        // Best-effort cleanup
      }
      sessionResolver.clear();
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
