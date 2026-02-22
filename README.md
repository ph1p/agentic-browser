# Agentic Browser

[![](https://img.shields.io/npm/v/agentic-browser)](https://www.npmjs.com/package/agentic-browser) ![](https://github.com/ph1p/agentic-browser/actions/workflows/ci.yml/badge.svg) ![](https://github.com/ph1p/agentic-browser/actions/workflows/release.yml/badge.svg)

CLI and MCP server to control a local Chrome session for AI agents.

## Purpose

- Starts a managed Chrome session.
- Accepts commands (for example `navigate`).
- Returns structured JSON output that an LLM can parse directly.
- Optimized for low-latency command execution by reusing CDP connections.

## Requirements

- Node.js 20+
- Installed Chrome

## Install

```bash
npm install agentic-browser -g
```

## Build (Development)

```bash
npm install
npm run build
```

## Quality Checks

```bash
npm run format
npm run lint
npm test
```

## Connect to Existing Chrome / Use Your Profile

By default, agentic-browser launches a fresh Chrome instance with an isolated profile. You can instead **connect to an already-running Chrome** or **launch Chrome with your real profile** (bookmarks, cookies, extensions, saved passwords).

### Connect to a running Chrome

Start Chrome yourself with remote debugging enabled:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
chrome.exe --remote-debugging-port=9222
```

Then connect agentic-browser to it:

```bash
agentic-browser agent start --cdp-url http://127.0.0.1:9222
# or low-level:
agentic-browser session:start --cdp-url http://127.0.0.1:9222
```

When connected this way, stopping the session will **not** kill your Chrome process.

### Launch Chrome with your real profile

```bash
# Use your default Chrome profile
agentic-browser agent start --user-profile default

# Use a specific profile directory
agentic-browser agent start --user-profile /path/to/chrome/profile
```

The default profile path is resolved per platform:
- **macOS:** `~/Library/Application Support/Google/Chrome`
- **Linux:** `~/.config/google-chrome`
- **Windows:** `%LOCALAPPDATA%\Google\Chrome\User Data`

### Environment variables

Both options can also be set via environment variables:

```bash
# Connect to existing Chrome
export AGENTIC_BROWSER_CDP_URL=http://127.0.0.1:9222

# Use default Chrome profile (set to "default", "true", or an absolute path)
export AGENTIC_BROWSER_USER_PROFILE=default
```

CLI flags take precedence over environment variables.

## Agent Commands (Recommended for LLMs)

The `agent` subcommand manages session state, auto-restarts on disconnect, generates command IDs, and retries failed commands automatically:

```bash
agentic-browser agent start
agentic-browser agent start --cdp-url http://127.0.0.1:9222
agentic-browser agent start --user-profile default
agentic-browser agent status
agentic-browser agent run navigate '{"url":"https://example.com"}'
agentic-browser agent run interact '{"action":"click","selector":"#login"}'
agentic-browser agent content --mode text
agentic-browser agent content --mode html --selector main
agentic-browser agent elements
agentic-browser agent elements --roles button,link --limit 20
agentic-browser agent memory-search "navigate:example.com" --domain example.com
agentic-browser agent stop
agentic-browser agent cleanup --dry-run --max-age-days 7
```

### Discover Interactive Elements

List all clickable/interactive elements on the current page:

```bash
agentic-browser agent elements
agentic-browser agent elements --roles button,link,input --visible-only --limit 30
agentic-browser agent elements --selector "#main-content"
```

Returns a JSON array of elements with CSS selectors usable in `agent run interact`:

```json
{
  "ok": true,
  "action": "elements",
  "elements": [
    {
      "selector": "#login-btn",
      "role": "button",
      "tagName": "button",
      "text": "Login",
      "actions": ["click"],
      "visible": true,
      "enabled": true
    }
  ],
  "totalFound": 42,
  "truncated": true
}
```

## MCP Server

### Quick Setup

```bash
npx agentic-browser setup
```

Detects your AI tools (Claude Code, Cursor) and writes the MCP config automatically.

### Manual Configuration

Add to your MCP config (`.mcp.json`, `.cursor/mcp.json`, etc.):

```json
{
  "mcpServers": {
    "agentic-browser": {
      "command": "npx",
      "args": ["agentic-browser", "mcp"]
    }
  }
}
```

## Low-Level CLI Commands

For direct control without session state management:

### 1. Start a Session

```bash
agentic-browser session:start
agentic-browser session:start --cdp-url http://127.0.0.1:9222
agentic-browser session:start --user-profile default
```

### 2. Read Session Status

```bash
agentic-browser session:status <sessionId>
```

### 3. Run a Command (`navigate` / `interact`)

```bash
agentic-browser command:run <sessionId> <commandId> navigate '{"url":"https://example.com"}'
agentic-browser command:run <sessionId> cmd-2 interact '{"action":"click","selector":"a"}'
```

More `interact` actions:

- `{"action":"type","selector":"input[name=q]","text":"innoq"}`
- `{"action":"press","key":"Enter"}`
- `{"action":"waitFor","selector":"main","timeoutMs":4000}`

### 4. Read Page Content

```bash
agentic-browser page:content <sessionId> --mode title
agentic-browser page:content <sessionId> --mode text
agentic-browser page:content <sessionId> --mode html --selector main
```

### 5. Rotate Session Token

```bash
agentic-browser session:auth <sessionId>
```

### 6. Restart / Stop / Cleanup

```bash
agentic-browser session:restart <sessionId>
agentic-browser session:stop <sessionId>
agentic-browser session:cleanup --max-age-days 7
```

### 7. Task Memory

```bash
agentic-browser memory:search "navigate:example.com" --domain example.com --limit 5
agentic-browser memory:inspect <insightId>
agentic-browser memory:verify <insightId>
agentic-browser memory:stats
```

## Recommended Agent Flow

1. `agent start` — launch Chrome and persist session.
2. `agent elements` — discover what's on the page.
3. `agent run navigate/interact` — execute actions using discovered selectors.
4. `agent content` — read page content after actions.
5. `agent memory-search` — reuse known selectors for repeated tasks.
6. `agent stop` — terminate when done.

## Important Notes for LLMs

- Exactly **one** managed session is supported at a time.
- Session state is persisted in `.agentic-browser/`.
- All commands print exactly one JSON line to `stdout`.
- `payloadJson` must be valid JSON.
- Parse only `stdout` as result object and use exit code for success/failure.

## Programmatic API

```ts
import { createAgenticBrowserCore } from "agentic-browser";

const core = createAgenticBrowserCore();
const session = await core.startSession();

await core.runCommand({
  sessionId: session.sessionId,
  commandId: "cmd-1",
  type: "navigate",
  payload: { url: "https://example.com" },
});

const elements = await core.getInteractiveElements({
  sessionId: session.sessionId,
  roles: ["button", "link"],
  visibleOnly: true,
  limit: 30,
});

const memory = core.searchMemory({
  taskIntent: "navigate:example.com",
  siteDomain: "example.com",
  limit: 3,
});

await core.stopSession(session.sessionId);
```

### Connect to existing Chrome programmatically

```ts
import { createAgenticBrowserCore } from "agentic-browser";

// Connect to a Chrome instance running with --remote-debugging-port=9222
const core = createAgenticBrowserCore({
  env: { ...process.env, AGENTIC_BROWSER_CDP_URL: "http://127.0.0.1:9222" },
});
const session = await core.startSession();
// session is now controlling the existing Chrome — stopping won't kill it
```

### Use default Chrome profile programmatically

```ts
import { createAgenticBrowserCore } from "agentic-browser";

const core = createAgenticBrowserCore({
  env: { ...process.env, AGENTIC_BROWSER_USER_PROFILE: "default" },
});
const session = await core.startSession();
// Chrome launched with your real profile (cookies, bookmarks, extensions)
```

## Documentation

```bash
npm run docs:dev     # Dev server at localhost:5173
npm run docs:build   # Static build
```
