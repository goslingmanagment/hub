import { describe, expect, it } from "vitest";

import {
  buildRunningSnapshot,
  CONFIG_DESCRIPTORS,
  ENV_CONFIG_KEYS,
  loadConfig,
} from "@agency_hub_core/shared";

// Minimal hermetic env: only the required fields, .env merging disabled so defaults
// are exactly what the schema declares.
const MINIMAL_ENV = {
  DATABASE_URL: "postgres://localhost/test",
  APP_ENCRYPTION_KEY: Buffer.alloc(32).toString("base64"),
} as unknown as NodeJS.ProcessEnv;

describe("config registry", () => {
  it("covers every env schema key exactly once", () => {
    const envKeys = new Set<string>(ENV_CONFIG_KEYS);
    const descriptorEnvNames = CONFIG_DESCRIPTORS.filter((d) => d.kind !== "derived").map(
      (d) => d.envName,
    );
    const descriptorEnvSet = new Set(descriptorEnvNames);

    expect([...envKeys].filter((key) => !descriptorEnvSet.has(key))).toEqual([]);
    expect(descriptorEnvNames.filter((key) => !envKeys.has(key))).toEqual([]);
    expect(descriptorEnvNames.length).toBe(descriptorEnvSet.size);
  });

  it("has unique descriptor keys", () => {
    const keys = CONFIG_DESCRIPTORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("never marks a secret/derived/complex/alias value as editable", () => {
    const unsafe = CONFIG_DESCRIPTORS.filter(
      (d) => d.editability === "editable" && ["secret", "derived", "complex", "alias"].includes(d.kind),
    );
    expect(unsafe.map((d) => d.key)).toEqual([]);
  });

  it("gives every editable numeric value a bound", () => {
    const unbounded = CONFIG_DESCRIPTORS.filter(
      (d) => d.editability === "editable" && d.kind === "number" && d.min === undefined && d.max === undefined,
    );
    expect(unbounded.map((d) => d.key)).toEqual([]);
  });

  it("declared defaults match what loadConfig actually produces", () => {
    const config = loadConfig(MINIMAL_ENV, { loadDotEnv: false });
    const plainValue = /^[\w.\-:/]+$/;
    const source = config as unknown as Record<string, unknown>;

    const mismatches: string[] = [];
    for (const descriptor of CONFIG_DESCRIPTORS) {
      if (!descriptor.configField) continue;
      if (!["boolean", "number", "string", "url"].includes(descriptor.kind)) continue;
      // Skip non-literal defaults ("(required)", "(unset)", fallback notes).
      if (!plainValue.test(descriptor.default)) continue;

      const actual = source[descriptor.configField as string];
      if (actual === undefined || actual === null) continue;
      if (String(actual) !== descriptor.default) {
        mismatches.push(`${descriptor.key}: loadConfig=${String(actual)} registry=${descriptor.default}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it("masks secrets and complex values in the running snapshot", () => {
    const snapshot = buildRunningSnapshot({
      ofapiApiKey: "leak-me",
      anthropicApiKey: "also-leak",
      encryptionKeysByVersion: new Map([[1, Buffer.alloc(32)]]),
      ofapiDmSyncEnabled: true,
    } as never);

    expect(snapshot.values.ofapiApiKey).toMatchObject({ masked: true, value: null, state: "set" });
    expect(snapshot.values.encryptionKeyRing).toMatchObject({ masked: true, state: "set" });
    expect(snapshot.values.ofapiDmSyncEnabled).toEqual({ value: true });
    // Real secret material must never appear anywhere in the serialized snapshot.
    expect(JSON.stringify(snapshot)).not.toContain("leak");
  });
});
