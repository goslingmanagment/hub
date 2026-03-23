import { describe, expect, it } from "vitest";

import config from "../vitest.config.ts";
import { INTEGRATION_TEST_TIMEOUT_MS } from "./helpers/timeouts.ts";

describe("vitest config", () => {
  it("aligns hook and test budgets with the shared integration timeout", () => {
    expect(INTEGRATION_TEST_TIMEOUT_MS).toBe(30_000);
    expect(config.test.hookTimeout).toBe(INTEGRATION_TEST_TIMEOUT_MS);
    expect(config.test.testTimeout).toBe(INTEGRATION_TEST_TIMEOUT_MS);
  });
});
