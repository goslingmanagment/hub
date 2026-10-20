import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  FANSLY_PAUSE_MIN_MS,
  loadConfig,
} from "@agency_hub_core/shared";

const baseEnv = {
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/agency_hub_core_test",
  APP_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
} satisfies NodeJS.ProcessEnv;
const originalDotenvQuiet = process.env.DOTENV_CONFIG_QUIET;
const originalCwd = process.cwd();
let testCwd: string;

beforeAll(async () => {
  process.env.DOTENV_CONFIG_QUIET = "true";
  testCwd = await mkdtemp(path.join(tmpdir(), "agency-hub-config-tests-"));
  process.chdir(testCwd);
});

afterAll(async () => {
  process.chdir(originalCwd);

  if (originalDotenvQuiet === undefined) {
    delete process.env.DOTENV_CONFIG_QUIET;
  } else {
    process.env.DOTENV_CONFIG_QUIET = originalDotenvQuiet;
  }

  await rm(testCwd, { recursive: true, force: true });
});

describe("config", () => {
  it("keeps the prompt-echo kill-switch off in env so enabling needs the audited PATCH", () => {
    expect(loadConfig(baseEnv).chatMuseAiPromptDebugEchoEnabled).toBe(false);
    expect(loadConfig({ ...baseEnv, CHATMUSE_AI_PROMPT_DEBUG_ECHO_ENABLED: "false" })
      .chatMuseAiPromptDebugEchoEnabled).toBe(false);
    // A deploy must be inert: env cannot turn it on.
    expect(() => loadConfig({ ...baseEnv, CHATMUSE_AI_PROMPT_DEBUG_ECHO_ENABLED: "true" }))
      .toThrow(/audited live-config API/);
    expect(() => loadConfig({ ...baseEnv, CHATMUSE_AI_PROMPT_DEBUG_ECHO_ENABLED: "maybe" }))
      .toThrow();
  });

  it("narrows trust proxy to a hop count or address list (audit P-9)", () => {
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "1" }).trustProxy).toBe(1);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "2" }).trustProxy).toBe(2);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "false" }).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "" }).trustProxy).toBe(false);
    expect(loadConfig({ ...baseEnv, TRUST_PROXY: "127.0.0.1, 10.0.0.0/8" }).trustProxy)
      .toBe("127.0.0.1, 10.0.0.0/8");
  });

  it("fails the boot on a Fansly pause below 2000 ms instead of raising it", () => {
    // The old example env said 1900; it must stop the process, not be clamped silently.
    for (const value of ["1", "1900", String(FANSLY_PAUSE_MIN_MS - 1)]) {
      expect(() => loadConfig({ ...baseEnv, FANSLY_DEFAULT_DELAY_MS: value }), value)
        .toThrow(`FANSLY_DEFAULT_DELAY_MS must be between 2000 and 60000 ms (got ${value})`);
    }
  });

  it("rejects partial service egress tuples without exposing credentials", () => {
    const fakePassword = "fake-partial-password";
    expect(() => loadConfig({
      ...baseEnv,
      SERVICE_EGRESS_PROXY_URL: "socks5://proxy.example.internal:1080",
      SERVICE_EGRESS_PROXY_PASSWORD: fakePassword,
    })).toThrow(/must be configured together/);

    try {
      loadConfig({
        ...baseEnv,
        SERVICE_EGRESS_PROXY_URL: "socks5://proxy.example.internal:1080",
        SERVICE_EGRESS_PROXY_PASSWORD: fakePassword,
      });
    } catch (error) {
      expect(String(error)).not.toContain(fakePassword);
    }
  });
});
