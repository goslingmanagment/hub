import { describe, expect, it } from "vitest";

import type { AppConfig } from "@agency_hub_core/shared";
import { collectCostWarnings, resolveEffectiveConfig, validateConfigOverride } from "@agency_hub_core/shared";

describe("validateConfigOverride", () => {
  it("clamps a number to the descriptor min", () => {
    // sessionTtlDays has min 1, max 365.
    const result = validateConfigOverride("sessionTtlDays", 0);
    expect(result).toEqual({ ok: true, value: 1 });
  });

  it("clamps a number to the descriptor max", () => {
    const result = validateConfigOverride("sessionTtlDays", 1000);
    expect(result).toEqual({ ok: true, value: 365 });
  });

  it("accepts an in-range number unchanged", () => {
    const result = validateConfigOverride("sessionTtlDays", 45);
    expect(result).toEqual({ ok: true, value: 45 });
  });

  it("clamps a cost-warned live window key to its upper bound (transactionRescanCapDays max 365)", () => {
    // L2: raise-expands-work keys carry a max so a live PATCH can't set an unbounded backfill
    // window. 1_000_000 clamps down to the descriptor max.
    expect(validateConfigOverride("transactionRescanCapDays", 1_000_000)).toEqual({ ok: true, value: 365 });
    expect(validateConfigOverride("transactionLookbackDays", 1_000_000)).toEqual({ ok: true, value: 365 });
  });

  it("rejects a non-finite number", () => {
    expect(validateConfigOverride("sessionTtlDays", Number.NaN).ok).toBe(false);
    expect(validateConfigOverride("sessionTtlDays", Number.POSITIVE_INFINITY).ok).toBe(false);
  });

  it("rejects a non-integer number (env schema is .int())", () => {
    expect(validateConfigOverride("sessionTtlDays", 1.5).ok).toBe(false);
  });

  it("trims a free string and rejects empty/whitespace", () => {
    // wbClosingLlmModel is an editable free string (env: .trim().min(1)).
    expect(validateConfigOverride("wbClosingLlmModel", "  claude-haiku-4-5  ")).toEqual({
      ok: true,
      value: "claude-haiku-4-5",
    });
    expect(validateConfigOverride("wbClosingLlmModel", "   ").ok).toBe(false);
    expect(validateConfigOverride("wbClosingLlmModel", "").ok).toBe(false);
  });

  it("enforces enum membership for a string", () => {
    // logLevel is an editable string with enumValues.
    expect(validateConfigOverride("logLevel", "debug")).toEqual({ ok: true, value: "debug" });
    expect(validateConfigOverride("logLevel", "verbose").ok).toBe(false);
  });

  it("rejects a type mismatch", () => {
    expect(validateConfigOverride("sessionTtlDays", "45").ok).toBe(false);
    expect(validateConfigOverride("logLevel", 7).ok).toBe(false);
    expect(validateConfigOverride("fanslyDmDeepBackfillEnabled", "true").ok).toBe(false);
  });

  it("accepts a boolean for a boolean key", () => {
    expect(validateConfigOverride("fanslyDmDeepBackfillEnabled", true)).toEqual({
      ok: true,
      value: true,
    });
  });

  it("rejects a 'never' (secret/infra) key", () => {
    // databaseUrl is editability 'never' (secret).
    expect(validateConfigOverride("databaseUrl", "postgres://x").ok).toBe(false);
    // trustProxy is editability 'never'.
    expect(validateConfigOverride("trustProxy", "true").ok).toBe(false);
  });

  it("rejects a 'staged' rollout flag", () => {
    // ofapiDmProjectionEnabled is editability 'staged'.
    expect(validateConfigOverride("ofapiDmProjectionEnabled", true).ok).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(validateConfigOverride("totallyMadeUpKey", 1).ok).toBe(false);
  });
});

// Minimal AppConfig stub carrying only the fields the resolver reads in these
// cases. Cast through unknown so we need not enumerate the whole interface.
const baseConfig = {
  sessionTtlDays: 30,
  logLevel: "info",
  ofapiDmProjectionEnabled: false,
} as unknown as AppConfig;

describe("resolveEffectiveConfig", () => {
  it("overlays an editable key and tags it 'override'", () => {
    const resolved = resolveEffectiveConfig(baseConfig, new Map([["sessionTtlDays", { value: 90 }]]));
    expect(resolved.values.sessionTtlDays).toEqual({ value: 90, source: "override" });
  });

  it("returns the env value with source 'env' when there is no override", () => {
    const resolved = resolveEffectiveConfig(baseConfig, new Map());
    expect(resolved.values.sessionTtlDays).toEqual({ value: 30, source: "env" });
    expect(resolved.values.logLevel).toEqual({ value: "info", source: "env" });
  });

  it("ignores an override for a non-editable key (absent from the map)", () => {
    // ofapiDmProjectionEnabled is 'staged' — the resolver emits only editable keys,
    // so it never appears (and an override can never take effect).
    const resolved = resolveEffectiveConfig(
      baseConfig,
      new Map([["ofapiDmProjectionEnabled", { value: true }]]),
    );
    expect(resolved.values.ofapiDmProjectionEnabled).toBeUndefined();
  });

  it("never emits secret/never values (no raw secret can leak through it)", () => {
    const resolved = resolveEffectiveConfig(
      { databaseUrl: "postgres://secret", sessionTtlDays: 30 } as unknown as AppConfig,
      new Map(),
    );
    expect(resolved.values.databaseUrl).toBeUndefined();
    expect(resolved.values.trustProxy).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain("secret");
  });

  it("clamps the overlaid value before tagging it", () => {
    const resolved = resolveEffectiveConfig(baseConfig, new Map([["sessionTtlDays", { value: 9999 }]]));
    expect(resolved.values.sessionTtlDays).toEqual({ value: 365, source: "override" });
  });

  it("accepts a plain-object override map", () => {
    const resolved = resolveEffectiveConfig(baseConfig, { logLevel: "warn" });
    expect(resolved.values.logLevel).toEqual({ value: "warn", source: "override" });
  });
});

describe("collectCostWarnings", () => {
  it("returns the descriptor costWarning for keys that carry one, keyed by config key", () => {
    const result = collectCostWarnings([
      "ofapiBurnAlertCreditsPerHour",
      "transactionLookbackDays", // a live key with no costWarning
      "ofapiCreditAlertThreshold",
    ]);
    expect(Object.keys(result).sort()).toEqual(
      ["ofapiBurnAlertCreditsPerHour", "ofapiCreditAlertThreshold"].sort(),
    );
    expect(result.ofapiBurnAlertCreditsPerHour).toMatch(/alarm/i);
  });

  it("ignores unknown keys and keys without a costWarning", () => {
    expect(collectCostWarnings(["logLevel", "nopeNotAKey", "sessionTtlDays"])).toEqual({});
  });

  it("returns an empty object for no keys", () => {
    expect(collectCostWarnings([])).toEqual({});
  });
});
