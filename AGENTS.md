# Agent Instructions

## Quick Reference

```bash
npm run build        # tsdown (~20ms)
npm run typecheck    # tsc --noEmit
npm run lint         # oxlint
npm run lint:fix     # oxlint --fix
npm run format       # oxfmt --write
npm test             # vitest run
npm run test:watch   # vitest
npm run docs:dev     # vocs dev server
```

## Architecture

AI-driven browser automation via Chrome DevTools Protocol (CDP). Three interfaces: CLI, MCP server, programmatic API.

### Module Map

```
src/
  index.ts                — Public API exports (AgenticBrowserCore + types)
  cli/
    index.ts              — CLI entry (Commander.js, colon-namespaced commands)
    runtime.ts            — AgenticBrowserCore class + factory functions
    app.ts                — AppContext DI container (config, logger, eventStore, tokenService, memoryService)
    commands/agent.ts     — Stateful agent commands (auto-restart, retry, session persistence)
    commands/*.ts         — Low-level CLI command handlers
  mcp/
    index.ts              — MCP server (stdio transport, 7 tools wrapping AgenticBrowserCore)
  session/
    browser-controller.ts — BrowserController interface + ChromeCdpBrowserController (CDP WebSocket)
    session-manager.ts    — Orchestrates sessions, commands, memory recording
    session-state.ts      — In-memory state tracking
    chrome-launcher.ts    — Chrome executable discovery & launch
  transport/
    control-api.ts        — ControlApi facade (delegates to SessionManager)
    ws-server.ts          — Authenticated WebSocket server
  memory/
    memory-service.ts     — Task memory coordination
    memory-index.ts       — Search/ranking (fuzzy match + freshness + domain)
    task-insight-store.ts — JSON file persistence
    staleness-detector.ts — Freshness state machine (fresh → suspect → stale)
    memory-schemas.ts     — Zod v4 schemas for memory domain
  auth/                   — Token-based session auth
  lib/
    config.ts             — loadConfig() from env vars
    domain-schemas.ts     — Zod v4 schemas (Session, Command, ConnectionState, etc.)
  observability/          — Logger + EventStore
```

### Key Flow

```
AgenticBrowserCore → ControlApi → SessionManager → BrowserController (CDP)
                                              → MemoryService (record evidence)
```

1. `createAgenticBrowserCore()` builds AppContext + ChromeCdpBrowserController
2. Commands execute via CDP `Runtime.evaluate` on the browser page
3. Results are recorded as evidence, indexed per-domain for memory search

## Code Conventions

- **ESM-only**: `"type": "module"`, use `.js` extensions in all TypeScript imports
- **Zod v4**: `import { z } from "zod"` — `z.record()` requires key+value args
- **Commander.js v14**: colon-namespaced commands (`session:start`, `memory:search`)
- **CLI output**: exactly one JSON line to `stdout`, errors to `stderr`
- **Types**: interfaces for public contracts, type aliases for unions/inferred
- **No console.log in MCP server**: use `process.stderr.write()` for debug output

## How to Add a New CLI Command

1. Create handler in `src/cli/commands/<name>.ts`
   ```ts
   export async function myCommand(runtime: Runtime, input: { ... }) {
     return runtime.api.doSomething(input);
   }
   ```
2. Register in `src/cli/index.ts` with `program.command("<name>").action(...)`
3. Optionally add agent wrapper in `src/cli/commands/agent.ts`

## How to Add a New BrowserController Method

1. Add to `BrowserController` interface in `src/session/browser-controller.ts`
2. Implement in `ChromeCdpBrowserController` (CDP `Runtime.evaluate` pattern)
3. Add stub in `MockBrowserController`
4. Propagate: `SessionManager` → `ControlApi` → `AgenticBrowserCore`

## How to Add a New MCP Tool

1. Add `server.tool()` call in `src/mcp/index.ts`
2. Use Zod v4 schemas for tool parameters
3. Call `AgenticBrowserCore` methods directly
4. Return `{ content: [{ type: "text", text: JSON.stringify(result) }] }`

## Testing

- **Unit**: `tests/unit/*.unit.test.ts` — pure logic with mocks
- **Contract**: `tests/contract/*.contract.test.ts` — API contract validation
- **Integration**: `tests/integration/*.integration.test.ts` — full lifecycle with MockBrowserController
- Factory: `createMockAgenticBrowserCore(env)` — never launches real Chrome
- Framework: Vitest, no special setup needed

## Environment Variables

- `AGENTIC_BROWSER_LOG_DIR` — base dir for sessions/memory/events (default: `.agentic-browser`)
- `AGENTIC_BROWSER_CHROME_EXECUTABLE_PATH` — explicit Chrome path (auto-discovered if not set)

## MCP Server

Subcommand: `agentic-browser mcp` (stdio transport). Setup: `agentic-browser setup`. Tools:

| Tool                    | Purpose                        |
| ----------------------- | ------------------------------ |
| `browser_start_session` | Start Chrome, return sessionId |
| `browser_navigate`      | Navigate to URL                |
| `browser_interact`      | click / type / press / waitFor |
| `browser_get_content`   | Get page title / text / html   |
| `browser_get_elements`  | Discover interactive elements  |
| `browser_search_memory` | Search task memory             |
| `browser_stop_session`  | Stop Chrome session            |

## For Browser Automation Tasks

See the [MCP Server](/mcp-server) docs for tool details and the README for CLI usage.
