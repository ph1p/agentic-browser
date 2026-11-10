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
import type { Command } from "commander";
import type { Runtime } from "./runtime.js";

export function registerCoreCommands(program: Command, runtime: Runtime): void {
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
}
