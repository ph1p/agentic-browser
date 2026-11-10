import { Command, InvalidArgumentError } from "commander";

import { createCliRuntime } from "./runtime.js";
import {
  agentCleanup,
  agentContent,
  agentDismissCookies,
  agentElements,
  agentEval,
  agentInteract,
  agentMemorySearch,
  agentNavigate,
  agentRestart,
  agentScreenshot,
  agentStart,
  agentStatus,
  agentStop,
  agentTabClose,
  agentTabNew,
  agentTabs,
  agentTabSwitch,
  agentTerminate,
  agentWait,
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
import { readPackageVersion } from "../lib/package-version.js";
import {
  INTERACTIVE_ELEMENT_ROLES,
  type InteractiveElementRole,
} from "../session/browser-controller.js";

function parseRoles(value: string): InteractiveElementRole[] {
  const roles = value
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  const valid: readonly string[] = INTERACTIVE_ELEMENT_ROLES;
  const unknown = roles.filter((r) => !valid.includes(r));
  if (unknown.length > 0) {
    throw new InvalidArgumentError(
      `unknown role(s) ${unknown.join(", ")}; valid: ${INTERACTIVE_ELEMENT_ROLES.join(", ")}`,
    );
  }
  return roles as InteractiveElementRole[];
}

const collect = (value: string, previous: string[] = []) => [...previous, value];

const FRAME_HELP = "iframe selector to run in (cross-origin frames supported)";
const INTENT_HELP =
  'task this step belongs to, e.g. "log in"; later steps on the same site join it, "" ends it (see agent memory-search)';

/** Resolves `<selector>` or `--text` (substring; `--exact` for exact match) to one locator. */
function resolveTarget(selector: string | undefined, options: { text?: string; exact?: boolean }) {
  if (selector && options.text) throw new Error("Pass either a selector or --text, not both");
  if (options.text) {
    return options.exact ? `text=${JSON.stringify(options.text)}` : `text=${options.text}`;
  }
  if (!selector) throw new Error("Missing target: pass a selector or --text <text>");
  return selector;
}

/** Options shared by the agent commands that act on one element. */
type StepOptions = { fallback: string[]; frame?: string };
type TargetOptions = StepOptions & { text?: string; exact?: boolean };

async function main() {
  const runtime = createCliRuntime();
  const program = new Command();
  program
    .name("agentic-browser")
    .description("Agentic browser CLI")
    .version(readPackageVersion(), "-v, --version", "print the version");

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
        // A command that ran but failed must exit non-zero so scripted callers
        // can detect it (the command itself didn't throw — it reported failure).
        if (result.resultStatus === "failed" || result.resultStatus === "timed_out") {
          process.exitCode = 1;
        }
      },
    );

  program
    .command("page:content")
    .argument("<sessionId>")
    .option("--mode <mode>", "title|text|html|a11y|summary", "summary")
    .option("--selector <selector>", "optional CSS selector")
    .option("--max-chars <n>", "max characters for text/html/a11y modes")
    .action(
      async (
        sessionId: string,
        options: {
          mode: "title" | "text" | "html" | "a11y" | "summary";
          selector?: string;
          maxChars?: string;
        },
      ) => {
        const result = await runPageContent(runtime, {
          sessionId,
          mode: options.mode,
          selector: options.selector,
          maxChars: options.maxChars ? Number.parseInt(options.maxChars, 10) : undefined,
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
    .description("Stateful agent wrapper with session persistence and auto-retry")
    // Declared once here; Commander also accepts it after the subcommand name.
    .option("--intent <task>", INTENT_HELP);
  /** --intent of the current agent step command; memory groups steps by it. */
  const stepIntent = () => agent.opts<{ intent?: string }>().intent;

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
      const result = await agentNavigate(runtime, { url, intent: stepIntent() });
      console.log(JSON.stringify(result));
    });

  agent
    .command("click")
    .argument(
      "[selector]",
      "element ref (e3) from agent elements, CSS selector, or composed locator (a >>> b)",
    )
    .option("--text <text>", "click the element with this visible text instead of a selector")
    .option("--exact", "with --text: require an exact text match")
    .option("--frame <selector>", FRAME_HELP)
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (selector: string | undefined, options: TargetOptions) => {
      const result = await agentInteract(runtime, {
        action: "click",
        selector: resolveTarget(selector, options),
        frame: options.frame,
        fallbackSelectors: options.fallback,
        intent: stepIntent(),
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("type")
    .argument(
      "<selectorOrText>",
      "element ref (e3), CSS selector, or the text to type when --into-text is used",
    )
    .argument("[text]")
    .option("--into-text <label>", "target the field by its visible text/label/placeholder")
    .option("--frame <selector>", FRAME_HELP)
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(
      async (
        first: string,
        second: string | undefined,
        options: StepOptions & { intoText?: string },
      ) => {
        const selector = options.intoText ? `text=${options.intoText}` : first;
        const text = options.intoText ? first : second;
        if (text === undefined) throw new Error("Missing text to type");
        const result = await agentInteract(runtime, {
          action: "type",
          selector,
          text,
          frame: options.frame,
          fallbackSelectors: options.fallback,
          intent: stepIntent(),
        });
        console.log(JSON.stringify(result));
      },
    );

  agent
    .command("press")
    .argument("<key>")
    .action(async (key: string) => {
      const result = await agentInteract(runtime, {
        action: "press",
        key,
        intent: stepIntent(),
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("wait")
    .description("Wait for an element, visible text, a URL and/or the page load")
    .argument("[selector]")
    .option("--text <text>", "wait until an element with this text exists")
    .option("--url <pattern>", "wait until the URL matches (substring, * glob, or /regex/)")
    .option("--load", "wait until document.readyState is complete")
    .option("--frame <selector>", FRAME_HELP)
    .option("--timeout <ms>", "timeout in milliseconds", "10000")
    .action(
      async (
        selector: string | undefined,
        options: { text?: string; url?: string; load?: boolean; frame?: string; timeout: string },
      ) => {
        const result = await agentWait(runtime, {
          selector,
          text: options.text,
          url: options.url,
          load: options.load,
          frame: options.frame,
          timeoutMs: Number.parseInt(options.timeout, 10),
        });
        console.log(JSON.stringify(result));
      },
    );

  agent
    .command("hover")
    .argument("[selector]")
    .option("--text <text>", "hover the element with this visible text")
    .option("--exact", "with --text: require an exact text match")
    .option("--frame <selector>", FRAME_HELP)
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (selector: string | undefined, options: TargetOptions) => {
      const result = await agentInteract(runtime, {
        action: "hover",
        selector: resolveTarget(selector, options),
        frame: options.frame,
        fallbackSelectors: options.fallback,
        intent: stepIntent(),
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("select")
    .argument("<selector>")
    .argument("<value>")
    .option("--frame <selector>", FRAME_HELP)
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (selector: string, value: string, options: StepOptions) => {
      const result = await agentInteract(runtime, {
        action: "select",
        selector,
        value,
        frame: options.frame,
        fallbackSelectors: options.fallback,
        intent: stepIntent(),
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("toggle")
    .argument("<selector>")
    .option("--frame <selector>", FRAME_HELP)
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (selector: string, options: StepOptions) => {
      const result = await agentInteract(runtime, {
        action: "toggle",
        selector,
        frame: options.frame,
        fallbackSelectors: options.fallback,
        intent: stepIntent(),
      });
      console.log(JSON.stringify(result));
    });

  agent
    .command("scroll")
    .option("--x <pixels>", "horizontal scroll delta", "0")
    .option("--y <pixels>", "vertical scroll delta", "0")
    .option("--selector <selector>", "scroll a specific element instead of the page")
    .option("--fallback <selector>", "backup CSS selector", collect, [])
    .action(async (options: StepOptions & { x: string; y: string; selector?: string }) => {
      const result = await agentInteract(runtime, {
        action: "scroll",
        selector: options.selector,
        fallbackSelectors: options.fallback,
        intent: stepIntent(),
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

  agent
    .command("eval")
    .description("Evaluate a JavaScript expression in the page and print its JSON value")
    .argument("<expression>", "expression; promises are awaited")
    .option("--frame <selector>", FRAME_HELP)
    .action(async (expression: string, options: { frame?: string }) => {
      const result = await agentEval(runtime, { expression, frame: options.frame });
      console.log(JSON.stringify(result));
    });

  agent
    .command("tabs")
    .description("List open tabs")
    .action(async () => {
      const result = await agentTabs(runtime);
      console.log(JSON.stringify(result));
    });

  agent
    .command("tab")
    .description("Switch the session to another tab")
    .argument("<id>", "tab id (or unique prefix) from agent tabs")
    .action(async (id: string) => {
      const result = await agentTabSwitch(runtime, { id });
      console.log(JSON.stringify(result));
    });

  agent
    .command("tab-new")
    .description("Open a new tab, switch to it and optionally navigate")
    .argument("[url]")
    .action(async (url: string | undefined) => {
      const result = await agentTabNew(runtime, { url });
      console.log(JSON.stringify(result));
    });

  agent
    .command("tab-close")
    .description("Close a tab (switches to another tab if it was active)")
    .argument("<id>", "tab id (or unique prefix) from agent tabs")
    .action(async (id: string) => {
      const result = await agentTabClose(runtime, { id });
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
    .option("--mode <mode>", "title|text|html|a11y|summary", "summary")
    .option("--selector <selector>", "optional CSS selector")
    .option("--max-chars <n>", "max characters for text/html/a11y modes")
    .action(
      async (options: {
        mode: "title" | "text" | "html" | "a11y" | "summary";
        selector?: string;
        maxChars?: string;
      }) => {
        const result = await agentContent(runtime, {
          mode: options.mode,
          selector: options.selector,
          maxChars: options.maxChars ? Number.parseInt(options.maxChars, 10) : undefined,
        });
        console.log(JSON.stringify(result));
      },
    );

  agent
    .command("screenshot")
    .description("Save a screenshot of the current page to a file")
    .option("--out <path>", "output file (default: <data dir>/screenshots/<session>-<ts>.<ext>)")
    .option("--format <format>", "png|jpeg", "png")
    .option("--quality <n>", "jpeg quality 0-100")
    .option("--full-page", "capture the full scrollable page")
    .action(
      async (options: { out?: string; format: string; quality?: string; fullPage?: boolean }) => {
        if (options.format !== "png" && options.format !== "jpeg") {
          throw new Error(`Invalid --format: ${options.format} (expected png or jpeg)`);
        }
        const result = await agentScreenshot(runtime, {
          out: options.out,
          format: options.format,
          quality: options.quality ? Number.parseInt(options.quality, 10) : undefined,
          fullPage: Boolean(options.fullPage),
        });
        console.log(JSON.stringify(result));
      },
    );

  agent
    .command("elements")
    .description("List interactive elements on the current page")
    .option(
      "--roles <roles>",
      `comma-separated roles: ${INTERACTIVE_ELEMENT_ROLES.join("|")}`,
      parseRoles,
    )
    .option("--visible-only", "only visible elements", true)
    .option("--no-visible-only", "include hidden elements")
    .option("--limit <n>", "max elements", "50")
    .option("--selector <selector>", "scope to CSS selector subtree")
    .option("--href <substring>", "only links whose href contains this")
    .option("--text <substring>", "only elements whose text/label contains this (case-insensitive)")
    .option("--frame <selector>", FRAME_HELP)
    .action(
      async (options: {
        roles?: InteractiveElementRole[];
        visibleOnly: boolean;
        limit: string;
        selector?: string;
        href?: string;
        text?: string;
        frame?: string;
      }) => {
        const result = await agentElements(runtime, {
          roles: options.roles,
          visibleOnly: options.visibleOnly,
          limit: Number.parseInt(options.limit, 10),
          selector: options.selector,
          href: options.href,
          text: options.text,
          frame: options.frame,
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
    // Honor an exit code an action may have set (e.g. a failed command:run).
    if (!keepAlive) process.exit(process.exitCode ?? 0);
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(JSON.stringify({ error: message }));
    process.exit(1);
  });
