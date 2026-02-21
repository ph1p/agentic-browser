# Copilot Instructions

This is agentic-browser, a TypeScript CLI and MCP server for AI-driven browser automation via Chrome DevTools Protocol.

For full architecture, conventions, and how-to guides, see `AGENTS.md`.

## Key Points

- ESM-only project (`"type": "module"`, use `.js` import extensions)
- Zod v4 for runtime validation (`z.record()` needs key+value args)
- Commander.js v14 for CLI (colon-namespaced commands)
- MCP server uses `@modelcontextprotocol/sdk` with stdio transport
- Build: `npm run build` (tsdown) | Test: `npm test` (vitest) | Lint: `npm run lint` (oxlint)
- For tests, always use `createMockAgenticBrowserCore(env)` to avoid launching real Chrome
- All CLI output must be exactly one JSON line to stdout
