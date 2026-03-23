import path from "node:path";

import { defineConfig } from "vitest/config";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./tests/helpers/timeouts.ts";

export default defineConfig({
  resolve: {
    alias: {
      "@agency_hub_core/contracts": path.resolve("packages/contracts/src/index.ts"),
      "@agency_hub_core/shared": path.resolve("packages/shared/src/index.ts"),
      "@agency_hub_core/db": path.resolve("packages/db/src/index.ts"),
      "@agency_hub_core/fansly": path.resolve("packages/fansly/src/index.ts"),
      "@agency_hub_core/onlyfans": path.resolve("packages/onlyfans/src/index.ts"),
      "@/": path.resolve("apps/dashboard/src") + "/",
      "react": path.resolve("apps/dashboard/node_modules/react"),
      "react-dom": path.resolve("apps/dashboard/node_modules/react-dom"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    hookTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
