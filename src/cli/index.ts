import { Command } from "commander";
import { createCliRuntime } from "./runtime.js";
import { readPackageVersion } from "../lib/package-version.js";
import { registerCoreCommands } from "./register-core.js";
import { registerAgentCommands } from "./register-agent.js";

async function main() {
  const runtime = createCliRuntime();
  const program = new Command();
  program
    .name("agentic-browser")
    .description("Agentic browser CLI")
    .version(readPackageVersion(), "-v, --version", "print the version");

  registerCoreCommands(program, runtime);
  registerAgentCommands(program, runtime);

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
