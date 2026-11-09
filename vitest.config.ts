import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/helpers/setup.ts"],
    coverage: {
      enabled: false,
      reporter: ["text", "html"],
      reportsDirectory: "coverage",
    },
  },
});
