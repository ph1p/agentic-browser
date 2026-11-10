import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { compactMemoryResults } from "../response-helpers.js";
import { getCore } from "../context.js";

export function registerMemoryTools(server: McpServer): void {
  server.tool(
    "browser_search_memory",
    "Search task memory for previously learned selectors, selector aliases, and interaction patterns. Matching is fuzzy, so a rephrased task still finds earlier runs. Results include recipe (the ordered steps that worked; needsInput marks steps whose typed text was redacted), selectorHints (proven selectors) and selectorAliases (human-readable names mapped to selectors with fallbacks). Use this before interacting with a known site to reuse proven selectors instead of rediscovering them.",
    {
      taskIntent: z
        .string()
        .describe(
          'What you want to do, e.g. "log in" or "search products". Use the same wording you passed as intent to navigate/interact',
        ),
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
}
