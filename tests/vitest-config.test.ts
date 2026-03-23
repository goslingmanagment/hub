import { describe, expect, it } from "vitest";

import config from "../vitest.config.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

describe("vitest config", () => {
  it("aligns hook and test budgets with the shared integration timeout", () => {
    const testConfig = config.test;

    expect(testConfig).toBeDefined();
    if (!testConfig) {
      throw new Error("Expected Vitest test config to be defined");
    }

    expect(INTEGRATION_TEST_TIMEOUT_MS).toBe(30_000);
    expect(testConfig.hookTimeout).toBe(INTEGRATION_TEST_TIMEOUT_MS);
    expect(testConfig.testTimeout).toBe(INTEGRATION_TEST_TIMEOUT_MS);
  });
});
