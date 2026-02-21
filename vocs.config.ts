import { defineConfig } from "vocs";

export default defineConfig({
  title: "agentic-browser",
  description: "Browser automation for AI agents via Chrome DevTools Protocol",
  basePath: "/agentic-browser",
  sidebar: [
    { text: "Overview", link: "/" },
    { text: "Getting Started", link: "/getting-started" },
    {
      text: "Guides",
      items: [
        { text: "CLI Reference", link: "/cli" },
        { text: "MCP Server", link: "/mcp-server" },
        { text: "Programmatic API", link: "/programmatic-api" },
      ],
    },
    {
      text: "Concepts",
      items: [
        { text: "Element Discovery", link: "/element-discovery" },
        { text: "Task Memory", link: "/task-memory" },
      ],
    },
  ],
});
