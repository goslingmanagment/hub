import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireTestPrerequisite,
  allowMissingTestPrerequisites,
  ALLOW_MISSING_TEST_PREREQUISITES_ENV,
} from "./helpers/prerequisites.ts";

describe("test prerequisite policy", () => {
  afterEach(() => {
    delete process.env[ALLOW_MISSING_TEST_PREREQUISITES_ENV];
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("fails fast by default when a prerequisite is unavailable", async () => {
    delete process.env[ALLOW_MISSING_TEST_PREREQUISITES_ENV];

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
    vi.stubEnv("CI", "");
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

  // GitHub Actions sets CI=true on every runner, the PC's included. The switch
  // there would turn every DB test into a skip and the run would stay green.
  it("refuses to skip in CI even when missing prerequisites are allowed", async () => {
    vi.stubEnv("CI", "true");
    process.env[ALLOW_MISSING_TEST_PREREQUISITES_ENV] = "1";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(() => allowMissingTestPrerequisites()).toThrow(`${ALLOW_MISSING_TEST_PREREQUISITES_ENV}=1 is refused with CI=true`);
    const acquired = acquireTestPrerequisite(async () => {
      throw new Error("docker socket unavailable");
    }, {
      prerequisite: "Docker-backed Postgres for integration tests",
      reason: "These tests use Testcontainers and require local Docker access.",
    });
    await expect(acquired).rejects.toThrow(`${ALLOW_MISSING_TEST_PREREQUISITES_ENV}=1 is refused with CI=true`);
    await expect(acquired).rejects.toThrow("Original error: docker socket unavailable");
    await expect(acquired).rejects.not.toThrow("to skip these tests instead");
    expect(warnSpy).not.toHaveBeenCalled();
    expect(allowMissingTestPrerequisites({ [ALLOW_MISSING_TEST_PREREQUISITES_ENV]: "1", CI: "false" })).toBe(true);
    expect(allowMissingTestPrerequisites({ CI: "true" })).toBe(false);
  });
});
