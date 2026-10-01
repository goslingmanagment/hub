import path from "node:path";

import { defineConfig } from "vitest/config";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./tests/helpers/timeouts.ts";
import { WeightedShardSequencer } from "./tests/helpers/weighted-shard-sequencer.ts";

export default defineConfig({
  resolve: {
    alias: {
      "@agency_hub_core/contracts": path.resolve("packages/contracts/src/index.ts"),
      "@kernel/sdk": path.resolve("packages/sdk/src/index.ts"),
      "@agency_hub_core/shared": path.resolve("packages/shared/src/index.ts"),
      "@agency_hub_core/db": path.resolve("packages/db/src/index.ts"),
      "@agency_hub_core/fansly": path.resolve("packages/fansly/src/index.ts"),
      "@agency_hub_core/onlyfans": path.resolve("packages/onlyfans/src/index.ts"),
      "@/": path.resolve("apps/dashboard/src") + "/",
      "react": path.resolve("apps/dashboard/node_modules/react"),
      "react-dom": path.resolve("apps/dashboard/node_modules/react-dom"),
      "react-router": path.resolve("apps/dashboard/node_modules/react-router"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // One Postgres per run; every acquisition clones its own database from the
    // template built here. See tests/helpers/global-setup.ts.
    globalSetup: ["tests/helpers/global-setup.ts"],
    hookTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
    // --shard=k/N packs files by measured duration (tests/ci/shard-weights.json)
    // instead of splitting by count; runs without --shard are unaffected.
    sequence: { sequencer: WeightedShardSequencer },
    // `pnpm test:coverage`: the whole suite (integration needs Docker) over
    // the production sources. Code a test runs in a child process (spawnSync
    // and the like) is not instrumented and shows as uncovered.
    coverage: {
      provider: "v8",
      include: ["apps/*/src/**/*.{ts,tsx}", "packages/*/src/**/*.{ts,tsx}"],
      reporter: ["text-summary", "json-summary", "lcov"],
    },
  },
});
