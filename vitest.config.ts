import path from "node:path";

import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@fansly-connect/contracts": path.resolve("packages/contracts/src/index.ts"),
      "@fansly-connect/shared": path.resolve("packages/shared/src/index.ts"),
      "@fansly-connect/db": path.resolve("packages/db/src/index.ts"),
      "@fansly-connect/fansly": path.resolve("packages/fansly/src/index.ts"),
      "@fansly-connect/onlyfans": path.resolve("packages/onlyfans/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
