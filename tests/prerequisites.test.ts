import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireTestPrerequisite,
  ALLOW_MISSING_TEST_PREREQUISITES_ENV,
} from "./helpers/prerequisites.ts";

describe("test prerequisite policy", () => {
  afterEach(() => {
    delete process.env[ALLOW_MISSING_TEST_PREREQUISITES_ENV];
    vi.restoreAllMocks();
  });

  it("fails fast by default when a prerequisite is unavailable", async () => {
    await expect(acquireTestPrerequisite(async () => {
      throw new Error("docker socket unavailable");
    }, {
      prerequisite: "Docker-backed Postgres for integration tests",
      reason: "These tests use Testcontainers and require local Docker access.",
    })).rejects.toThrow(
      "Missing test prerequisite: Docker-backed Postgres for integration tests.",
    );
  });

  it("returns null and warns when missing prerequisites are explicitly allowed", async () => {
    process.env[ALLOW_MISSING_TEST_PREREQUISITES_ENV] = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await expect(acquireTestPrerequisite(async () => {
      throw new Error("operation not permitted");
    }, {
      prerequisite: "loopback TCP listener for HTTP proxy tests",
      reason: "These tests need permission to bind an ephemeral localhost socket.",
    })).resolves.toBeNull();

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining(
      `Set ${ALLOW_MISSING_TEST_PREREQUISITES_ENV}=1 to skip these tests instead.`,
    ));
  });
});
