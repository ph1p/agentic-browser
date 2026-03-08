import { Command } from "commander";

import { createCliRuntime } from "./runtime.js";
import {
  agentCleanup,
  agentContent,
  agentDismissCookies,
  agentElements,
  agentInteract,
  agentMemorySearch,
  agentNavigate,
  agentRestart,
  agentStart,
  agentStatus,
  agentStop,
  agentTerminate,
} from "./commands/agent.js";
import { runSessionStart } from "./commands/session-start.js";
import { runSessionStatus } from "./commands/session-status.js";
import { runSessionStop } from "./commands/session-stop.js";
import { runSessionCleanup } from "./commands/session-cleanup.js";
import { runSessionRestart } from "./commands/session-restart.js";
import { runSessionAuth } from "./commands/session-auth.js";
import { runCommand } from "./commands/command-run.js";
import { runPageContent } from "./commands/page-content.js";
import { runMemorySearch } from "./commands/memory-search.js";
import { runMemoryInspect } from "./commands/memory-inspect.js";
import { runMemoryVerify } from "./commands/memory-verify.js";
import { runMemoryStats } from "./commands/memory-stats.js";

async function main() {
  const runtime = createCliRuntime();
  const program = new Command();
  program.name("agentic-browser").description("Agentic browser CLI");
  const collect = (value: string, previous: string[] = []) => [...previous, value];

  program
    .command("session:start")
    .option("--cdp-url <url>", "connect to existing Chrome via CDP endpoint URL")
    .option("--user-profile <path>", "use 'default' for system Chrome profile or an absolute path")
    .option("--headless", "run Chrome in headless mode (no visible window)")
    .option("--user-agent <string>", "override the browser user-agent string")
    .action(
      async (options: {
        cdpUrl?: string;
        userProfile?: string;
        headless?: boolean;
        userAgent?: string;
      }) => {
        if (options.cdpUrl) {
          runtime.context.config.cdpUrl = options.cdpUrl;
        }
        if (options.userProfile) {
          runtime.context.config.userProfileDir =
            options.userProfile === "true" || options.userProfile === "default"
              ? "default"
              : options.userProfile;
        }
        if (options.headless) {
          runtime.context.config.headless = true;
        }
        if (options.userAgent) {
          runtime.context.config.userAgent = options.userAgent;
        }
        const result = await runSessionStart(runtime, { browser: "chrome" });
        console.log(JSON.stringify(result));
      },
    );

  program
    .command("session:status")
    .argument("<sessionId>")
    .action(async (sessionId: string) => {
      const result = await runSessionStatus(runtime, { sessionId });
      console.log(JSON.stringify(result));
    });

  program
    .command("session:stop")
    .argument("<sessionId>")
    .action(async (sessionId: string) => {
      const result = await runSessionStop(runtime, { sessionId });
      console.log(JSON.stringify(result));
    });

  program
    .command("session:cleanup")
    .option("--max-age-days <days>", "remove terminated sessions older than N days", "7")
    .option("--dry-run", "show what would be removed without deleting")
    .action(async (options: { maxAgeDays: string; dryRun?: boolean }) => {
      const result = await runSessionCleanup(runtime, {
        maxAgeDays: Number.parseFloat(options.maxAgeDays),
        dryRun: Boolean(options.dryRun),
      });
      console.log(JSON.stringify(result));
    });

  program
    .command("session:restart")
    .argument("<sessionId>")
    .action(async (sessionId: string) => {
      const result = await runSessionRestart(runtime, { sessionId });
      console.log(JSON.stringify(result));
    });

  program
    .command("session:auth")
    .argument("<sessionId>")
    .action(async (sessionId: string) => {
      const result = await runSessionAuth(runtime, { sessionId });
      console.log(JSON.stringify(result));
    });

  program
    .command("command:run")
    .argument("<sessionId>")
    .argument("<commandId>")
    .argument("<type>")
    .argument("<payloadJson>")
    .action(
      async (
        sessionId: string,
        commandId: string,
        type: "navigate" | "interact" | "restart" | "terminate",
        payloadJson: string,
      ) => {
        const result = await runCommand(runtime, {
          sessionId,
          commandId,
          type,
          payload: JSON.parse(payloadJson),
        });
        console.log(JSON.stringify(result));
      },
    );

  program
    .command("page:content")
    .argument("<sessionId>")
    .option("--mode <mode>", "title|text|html|a11y", "text")
    .option("--selector <selector>", "optional CSS selector")
    .action(
      async (
        sessionId: string,
        options: { mode: "title" | "text" | "html" | "a11y"; selector?: string },
      ) => {
        const result = await runPageContent(runtime, {
          sessionId,
          mode: options.mode,
          selector: options.selector,
        });
        console.log(JSON.stringify(result));
      },
    );

  program
    .command("memory:search")
    .argument("<taskIntent>")
    .option("--domain <domain>", "website domain filter")
    .option("--limit <limit>", "max results", "10")
    .action(async (taskIntent: string, options: { domain?: string; limit: string }) => {
      const result = await runMemorySearch(runtime, {
        taskIntent,
        siteDomain: options.domain,
        limit: Number.parseInt(options.limit, 10),
      });
      console.log(JSON.stringify(result));
    });

  program
    .command("memory:inspect")
    .argument("<insightId>")
    .action(async (insightId: string) => {
      const result = await runMemoryInspect(runtime, { insightId });
      console.log(JSON.stringify(result));
    });

  program
    .command("memory:verify")
    .argument("<insightId>")
    .action(async (insightId: string) => {
      const result = await runMemoryVerify(runtime, { insightId });
      console.log(JSON.stringify(result));
    });

  program.command("memory:stats").action(async () => {
    const result = await runMemoryStats(runtime);
    console.log(JSON.stringify(result));
  });

  const agent = program
    .command("agent")
    .description("Stateful agent wrapper with session persistence and auto-retry");

  agent
    .command("start")
    .option("--cdp-url <url>", "connect to existing Chrome via CDP endpoint URL")
    .option("--user-profile <path>", "use 'default' for system Chrome profile or an absolute path")
    .option("--headless", "run Chrome in headless mode (no visible window)")
    .option("--user-agent <string>", "override the browser user-agent string")
    .action(
      async (options: {
        cdpUrl?: string;
        userProfile?: string;
        headless?: boolean;
        userAgent?: string;
      }) => {
        if (options.cdpUrl) {
          runtime.context.config.cdpUrl = options.cdpUrl;
        }
        if (options.userProfile) {
          runtime.context.config.userProfileDir =
            options.userProfile === "true" || options.userProfile === "default"
              ? "default"
              : options.userProfile;
        }
        if (options.headless) {
          runtime.context.config.headless = true;
        }
        if (options.userAgent) {
          runtime.context.config.userAgent = options.userAgent;
        }
        const result = await agentStart(runtime);
        console.log(JSON.stringify(result));
      },
    );

  agent.command("status").action(async () => {
    const result = await agentStatus(runtime);
    console.log(JSON.stringify(result));
  });

  agent.command("stop").action(async () => {
    const result = await agentStop(runtime);
    console.log(JSON.stringify(result));
  });

  agent
    .command("navigate")
    .argument("<url>")
    .action(async (url: string) => {
      const result = await agentNavigate(runtime, { url });
      console.log(JSON.stringify(result));
    });

  agent
    .command("click")
    .argument("<selector>")
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (selector: string, options: { fallback: string[] }) => {
      const result = await agentInteract(runtime, {
        action: "click",
        selector,
        fallbackSelectors: options.fallback,
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("type")
    .argument("<selector>")
    .argument("<text>")
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (selector: string, text: string, options: { fallback: string[] }) => {
      const result = await agentInteract(runtime, {
        action: "type",
        selector,
        text,
        fallbackSelectors: options.fallback,
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("press")
    .argument("<key>")
    .action(async (key: string) => {
      const result = await agentInteract(runtime, {
        action: "press",
        key,
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("wait")
    .argument("<selector>")
    .option("--timeout <ms>", "timeout in milliseconds", "2000")
    .action(async (selector: string, options: { timeout: string }) => {
      const result = await agentInteract(runtime, {
        action: "waitFor",
        selector,
        timeoutMs: Number.parseInt(options.timeout, 10),
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("hover")
    .argument("<selector>")
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (selector: string, options: { fallback: string[] }) => {
      const result = await agentInteract(runtime, {
        action: "hover",
        selector,
        fallbackSelectors: options.fallback,
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("select")
    .argument("<selector>")
    .argument("<value>")
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (selector: string, value: string, options: { fallback: string[] }) => {
      const result = await agentInteract(runtime, {
        action: "select",
        selector,
        value,
        fallbackSelectors: options.fallback,
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("toggle")
    .argument("<selector>")
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (selector: string, options: { fallback: string[] }) => {
      const result = await agentInteract(runtime, {
        action: "toggle",
        selector,
        fallbackSelectors: options.fallback,
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("scroll")
    .option("--x <pixels>", "horizontal scroll delta", "0")
    .option("--y <pixels>", "vertical scroll delta", "0")
    .option("--selector <selector>", "scroll a specific element instead of the page")
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (options: { x: string; y: string; selector?: string; fallback: string[] }) => {
      const result = await agentInteract(runtime, {
        action: "scroll",
        selector: options.selector,
        fallbackSelectors: options.fallback,
        scrollX: Number.parseInt(options.x, 10),
        scrollY: Number.parseInt(options.y, 10),
      });
      console.log(JSON.stringify(result));
    });

  agent.command("back").action(async () => {
    const result = await agentInteract(runtime, { action: "goBack" });
    console.log(JSON.stringify(result));
  });

  agent.command("forward").action(async () => {
    const result = await agentInteract(runtime, { action: "goForward" });
    console.log(JSON.stringify(result));
  });

  agent.command("refresh").action(async () => {
    const result = await agentInteract(runtime, { action: "refresh" });
    console.log(JSON.stringify(result));
  });

  agent
    .command("dialog")
    .option("--dismiss", "dismiss the current dialog")
    .option("--value <text>", "prompt response text")
    .action(async (options: { dismiss?: boolean; value?: string }) => {
      const result = await agentInteract(runtime, {
        action: "dialog",
        text: options.dismiss ? "dismiss" : undefined,
        value: options.value,
      });
      console.log(JSON.stringify(result));
    });

  agent.command("cookies").action(async () => {
    const result = await agentDismissCookies(runtime);
    console.log(JSON.stringify(result));
  });

  agent.command("restart").action(async () => {
    const result = await agentRestart(runtime);
    console.log(JSON.stringify(result));
  });

  agent.command("terminate").action(async () => {
    const result = await agentTerminate(runtime);
    console.log(JSON.stringify(result));
  });

  agent
    .command("content")
    .option("--mode <mode>", "title|text|html|a11y", "text")
    .option("--selector <selector>", "optional CSS selector")
    .action(async (options: { mode: "title" | "text" | "html" | "a11y"; selector?: string }) => {
      const result = await agentContent(runtime, options);
      console.log(JSON.stringify(result));
    });

  agent
    .command("elements")
    .description("List interactive elements on the current page")
    .option("--roles <roles>", "comma-separated roles filter", (v) => v.split(","))
    .option("--visible-only", "only visible elements", true)
    .option("--no-visible-only", "include hidden elements")
    .option("--limit <n>", "max elements", "50")
    .option("--selector <selector>", "scope to CSS selector subtree")
    .action(
      async (options: {
        roles?: string[];
        visibleOnly: boolean;
        limit: string;
        selector?: string;
      }) => {
        const result = await agentElements(runtime, {
          roles: options.roles,
          visibleOnly: options.visibleOnly,
          limit: Number.parseInt(options.limit, 10),
          selector: options.selector,
        });
        console.log(JSON.stringify(result));
      },
    );

  agent
    .command("memory-search")
    .argument("<taskIntent>")
    .option("--domain <domain>", "website domain filter")
    .option("--limit <limit>", "max results", "5")
    .action(async (taskIntent: string, options: { domain?: string; limit: string }) => {
      const result = await agentMemorySearch(runtime, {
        taskIntent,
        siteDomain: options.domain,
        limit: Number.parseInt(options.limit, 10),
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("cleanup")
    .option("--max-age-days <days>", "remove sessions older than N days", "7")
    .option("--dry-run", "show what would be removed")
    .action(async (options: { maxAgeDays: string; dryRun?: boolean }) => {
      const result = await agentCleanup(runtime, {
        maxAgeDays: Number.parseFloat(options.maxAgeDays),
        dryRun: Boolean(options.dryRun),
      });
      console.log(JSON.stringify(result));
    });

  let keepAlive = false;

  program
    .command("mcp")
    .description("Start the MCP server (stdio transport)")
    .action(async () => {
      keepAlive = true;
      const { main: startMcpServer } = await import("../mcp/index.js");
      await startMcpServer();
    });

  program
    .command("setup")
    .description("Configure agentic-browser as MCP server for your AI tool")
    .action(async () => {
      const { runSetup } = await import("./commands/setup.js");
      await runSetup();
    });

  await program.parseAsync(process.argv);
  return keepAlive;
}

void main()
  .then((keepAlive) => {
    if (!keepAlive) process.exit(0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ error: message }));
    process.exit(1);
  });
