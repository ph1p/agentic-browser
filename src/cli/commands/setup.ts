import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";

export interface McpConfig {
  mcpServers?: Record<string, { command: string; args: string[] }>;
  [key: string]: unknown;
}

export interface ToolTarget {
  name: string;
  configPath: string;
}

export const SERVER_ENTRY = { command: "npx", args: ["agentic-browser", "mcp"] };

export function detectTools(cwd: string = process.cwd()): ToolTarget[] {
  const targets: ToolTarget[] = [];

  // Claude Code — project-level .mcp.json
  targets.push({ name: "Claude Code (project)", configPath: path.join(cwd, ".mcp.json") });

  // Cursor — project-level .cursor/mcp.json
  const cursorDir = path.join(cwd, ".cursor");
  if (fs.existsSync(cursorDir)) {
    targets.push({ name: "Cursor", configPath: path.join(cursorDir, "mcp.json") });
  }

  return targets;
}

export function readJsonFile(filePath: string): McpConfig {
  if (!fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as McpConfig;
  } catch {
    return {};
  }
}

export function writeJsonFile(filePath: string, data: McpConfig): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

export function applyConfig(target: ToolTarget): void {
  const config = readJsonFile(target.configPath);
  config.mcpServers = config.mcpServers ?? {};
  config.mcpServers["agentic-browser"] = SERVER_ENTRY;
  writeJsonFile(target.configPath, config);
}

export async function runSetup(): Promise<void> {
  const targets = detectTools();

  console.log("agentic-browser — MCP server setup\n");
  console.log("Detected targets:\n");
  for (let i = 0; i < targets.length; i++) {
    const exists = fs.existsSync(targets[i].configPath) ? "" : " (will create)";
    console.log(`  ${i + 1}. ${targets[i].name}${exists}`);
  }
  if (targets.length > 1) {
    console.log(`  ${targets.length + 1}. All of the above`);
  }
  console.log();

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const max = targets.length > 1 ? targets.length + 1 : targets.length;
    const answer = await rl.question(`Select [1-${max}]: `);
    const choice = Number.parseInt(answer, 10);

    if (Number.isNaN(choice) || choice < 1 || choice > max) {
      console.log("Invalid selection.");
      return;
    }

    const selected = choice === targets.length + 1 ? targets : [targets[choice - 1]];
    console.log();
    for (const target of selected) {
      applyConfig(target);
      console.log(`  Configured ${target.configPath}`);
    }
    console.log("\nDone. Restart your AI tool to pick up the new MCP server.");
  } finally {
    rl.close();
  }
}
