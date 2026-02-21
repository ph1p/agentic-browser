import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/index.ts", "src/mcp/index.ts"],
  format: "esm",
  target: "node20",
  clean: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
