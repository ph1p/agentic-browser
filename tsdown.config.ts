import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/index.ts", "src/mcp/index.ts", "src/relay/index.ts"],
  format: "esm",
  target: "node22",
  clean: true,
  dts: true,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
