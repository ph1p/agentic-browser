import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  applyConfig,
  detectTools,
  readJsonFile,
  SERVER_ENTRY,
  writeJsonFile,
} from "../../src/cli/commands/setup.js";

const tmpBase = `/tmp/agentic-browser-setup-test-${Math.random().toString(16).slice(2)}`;

beforeEach(() => {
  fs.mkdirSync(tmpBase, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe("detectTools", () => {
  it("always includes Claude Code target", () => {
    const targets = detectTools(tmpBase);
    expect(targets.length).toBe(1);
    expect(targets[0].name).toBe("Claude Code (project)");
    expect(targets[0].configPath).toBe(path.join(tmpBase, ".mcp.json"));
  });

  it("includes Cursor when .cursor/ directory exists", () => {
    fs.mkdirSync(path.join(tmpBase, ".cursor"), { recursive: true });
    const targets = detectTools(tmpBase);
    expect(targets.length).toBe(2);
    expect(targets[1].name).toBe("Cursor");
    expect(targets[1].configPath).toBe(path.join(tmpBase, ".cursor", "mcp.json"));
  });
});

describe("readJsonFile", () => {
  it("returns empty object for missing file", () => {
    expect(readJsonFile(path.join(tmpBase, "nonexistent.json"))).toEqual({});
  });

  it("returns parsed content for existing file", () => {
    const filePath = path.join(tmpBase, "test.json");
    fs.writeFileSync(filePath, '{"foo":"bar"}');
    expect(readJsonFile(filePath)).toEqual({ foo: "bar" });
  });

  it("returns empty object for invalid JSON", () => {
    const filePath = path.join(tmpBase, "bad.json");
    fs.writeFileSync(filePath, "not json");
    expect(readJsonFile(filePath)).toEqual({});
  });
});

describe("writeJsonFile", () => {
  it("creates file with formatted JSON", () => {
    const filePath = path.join(tmpBase, "out.json");
    writeJsonFile(filePath, { key: "value" });
    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toBe('{\n  "key": "value"\n}\n');
  });

  it("creates parent directories if needed", () => {
    const filePath = path.join(tmpBase, "nested", "dir", "out.json");
    writeJsonFile(filePath, { ok: true });
    expect(fs.existsSync(filePath)).toBe(true);
  });
});

describe("applyConfig", () => {
  it("creates new config with mcpServers entry", () => {
    const configPath = path.join(tmpBase, ".mcp.json");
    applyConfig({ name: "Test", configPath });

    const result = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(result.mcpServers["agentic-browser"]).toEqual(SERVER_ENTRY);
  });

  it("merges into existing config without overwriting other keys", () => {
    const configPath = path.join(tmpBase, ".mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { "other-server": { command: "other", args: [] } },
        customKey: 42,
      }),
    );

    applyConfig({ name: "Test", configPath });

    const result = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(result.mcpServers["agentic-browser"]).toEqual(SERVER_ENTRY);
    expect(result.mcpServers["other-server"]).toEqual({ command: "other", args: [] });
    expect(result.customKey).toBe(42);
  });

  it("overwrites existing agentic-browser entry", () => {
    const configPath = path.join(tmpBase, ".mcp.json");
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { "agentic-browser": { command: "old", args: ["old"] } },
      }),
    );

    applyConfig({ name: "Test", configPath });

    const result = JSON.parse(fs.readFileSync(configPath, "utf8"));
    expect(result.mcpServers["agentic-browser"]).toEqual(SERVER_ENTRY);
  });
});
