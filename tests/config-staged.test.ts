import { describe, expect, it } from "vitest";

import { applyBootOverrides, validateStagedOverride } from "@agency_hub_core/shared";
import type { AppConfig } from "@agency_hub_core/shared";
import {
  validateStagedTransition,
  type RunningFlagState,
  type StagedPatchEntry,
} from "../apps/runtime/src/services/staged-config.ts";

// A minimal AppConfig with the fields applyBootOverrides reads/writes: the 8 boot
// boolean flags plus the fields the generic merged-invariant check consults. Partial
// cast keeps the test free of the full env schema.
function baseConfig(): AppConfig {
  return {
    ofapiDmProjectionEnabled: false,
    ofapiDmSyncEnabled: false,
    ofapiAccountHealthEnabled: false,
    ofapiCreditLedgerEnabled: false,
    ofapiBalancePingEnabled: false,
    ofapiAudienceSyncEnabled: false,
    ofapiPresenceProjectionEnabled: false,
    onlyFansTopSpendersEnabled: false,
    // Invariant inputs (generic/defensive; no current boot key touches these).
    onlyFansPublicProfileResolutionEnabled: false,
    onlyFansPublicProfileAllowDirect: false,
    onlyFansPublicProfileProxy: null,
    syncPageExecutorConcurrency: 1,
    syncSharedRateLimitEnabled: true,
    // A runtimeApply:'none' editable key that must never be boot-applied.
    logLevel: "info",
  } as unknown as AppConfig;
}

function overrides(
  entries: Array<[string, unknown]>,
): Map<string, { value: unknown; version?: number }> {
  return new Map(entries.map(([key, value], i) => [key, { value, version: i + 1 }]));
}

describe("validateStagedOverride", () => {
  it("accepts a boolean for a boot (staged) key", () => {
    expect(validateStagedOverride("ofapiDmProjectionEnabled", true)).toEqual({ ok: true, value: true });
    expect(validateStagedOverride("onlyFansTopSpendersEnabled", false)).toEqual({ ok: true, value: false });
  });

  it("rejects a non-boolean value for a boot key", () => {
    expect(validateStagedOverride("ofapiDmProjectionEnabled", "true").ok).toBe(false);
    expect(validateStagedOverride("ofapiDmProjectionEnabled", 1).ok).toBe(false);
  });

  it("rejects an unknown key", () => {
    expect(validateStagedOverride("nopeNotAKey", true).ok).toBe(false);
  });

  it("rejects a 'never' key, an 'editable' live key, and a 'none' staged flag", () => {
    // databaseUrl: editability never / runtimeApply none
    expect(validateStagedOverride("databaseUrl", true).ok).toBe(false);
    // transactionLookbackDays: editable but runtimeApply 'live' (not boot)
    expect(validateStagedOverride("transactionLookbackDays", true).ok).toBe(false);
    // onlyFansPublicProfileResolutionEnabled: staged editability but runtimeApply 'none'
    expect(validateStagedOverride("onlyFansPublicProfileResolutionEnabled", true).ok).toBe(false);
    // logLevel: editable runtimeApply 'none'
    expect(validateStagedOverride("logLevel", "debug").ok).toBe(false);
  });
});

describe("applyBootOverrides", () => {
  it("returns the same config object and no skips when there are no overrides", () => {
    const config = baseConfig();
    const result = applyBootOverrides(config, new Map());
    expect(result.config).toBe(config);
    expect(result.skipped).toEqual([]);
  });

  it("applies a boot boolean override onto its configField (clone, not mutation)", () => {
    const config = baseConfig();
    const result = applyBootOverrides(config, overrides([["ofapiDmProjectionEnabled", true]]));
    expect(result.config.ofapiDmProjectionEnabled).toBe(true);
    expect(result.skipped).toEqual([]);
    // Original untouched.
    expect(config.ofapiDmProjectionEnabled).toBe(false);
  });

  it("ignores a non-boot staged flag (onlyFansPublicProfileResolutionEnabled) with a reason", () => {
    const config = baseConfig();
    const result = applyBootOverrides(
      config,
      overrides([["onlyFansPublicProfileResolutionEnabled", true]]),
    );
    // Not a boot key → never applied; config identity unchanged; recorded as skipped.
    expect(result.config).toBe(config);
    expect(result.config.onlyFansPublicProfileResolutionEnabled).toBe(false);
    expect(result.skipped.map((s) => s.key)).toContain("onlyFansPublicProfileResolutionEnabled");
  });

  it("ignores a runtimeApply:'none' editable key (logLevel) with a reason", () => {
    const config = baseConfig();
    const result = applyBootOverrides(config, overrides([["logLevel", "debug"]]));
    expect(result.config).toBe(config);
    expect(result.config.logLevel).toBe("info");
    expect(result.skipped.map((s) => s.key)).toContain("logLevel");
  });

  it("skips an invalid (non-boolean) value for a boot key with a reason, never throwing", () => {
    const config = baseConfig();
    const result = applyBootOverrides(config, overrides([["ofapiDmProjectionEnabled", "yes"]]));
    // No valid candidate survived → original config returned.
    expect(result.config).toBe(config);
    expect(result.config.ofapiDmProjectionEnabled).toBe(false);
    const skip = result.skipped.find((s) => s.key === "ofapiDmProjectionEnabled");
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/boolean/);
  });

  it("applies the valid boot keys and skips the invalid ones in one call", () => {
    const config = baseConfig();
    const result = applyBootOverrides(
      config,
      overrides([
        ["ofapiDmProjectionEnabled", true],
        ["ofapiDmSyncEnabled", 1],
      ]),
    );
    expect(result.config.ofapiDmProjectionEnabled).toBe(true);
    expect(result.config.ofapiDmSyncEnabled).toBe(false);
    expect(result.skipped.map((s) => s.key)).toContain("ofapiDmSyncEnabled");
  });

  it("reverts overrides and records a reason when the merged config breaks an invariant (generic regression)", () => {
    // No current boot key participates in an invariant, so synthesize one by starting
    // from a config that is one boot flip away from a violation: concurrency > 1 with
    // the shared limiter env-OFF, and a boot override that (hypothetically) flips a key.
    // We exercise the revert path by making the BASE config already invariant-violating
    // after a boot apply: set concurrency high + limiter off in env, then confirm a
    // boot apply that leaves the violation intact reverts the applied key.
    const config = {
      ...baseConfig(),
      syncPageExecutorConcurrency: 4,
      syncSharedRateLimitEnabled: false,
    } as unknown as AppConfig;
    const result = applyBootOverrides(config, overrides([["ofapiDmProjectionEnabled", true]]));
    // The merged config violates the concurrency invariant (independent of the flip), so
    // the applied key is reverted to env and recorded as skipped; config identity is the
    // original since nothing survived.
    expect(result.config).toBe(config);
    expect(result.config.ofapiDmProjectionEnabled).toBe(false);
    const skip = result.skipped.find((s) => s.key === "ofapiDmProjectionEnabled");
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/SYNC_SHARED_RATE_LIMIT_ENABLED/);
  });

  it("does not falsely revert when the merged config satisfies the invariants", () => {
    // Both keys participate in a chain (accountHealth requires dmSync requires dmProjection),
    // so enabling accountHealth without its prereqs would trip the requires fail-safe. Use
    // two leaf-ish keys whose prereqs are also satisfied: enable the FULL #49 chain.
    const config = baseConfig();
    const result = applyBootOverrides(
      config,
      overrides([
        ["ofapiDmProjectionEnabled", true],
        ["ofapiDmSyncEnabled", true],
        ["ofapiAccountHealthEnabled", true],
      ]),
    );
    expect(result.config.ofapiDmProjectionEnabled).toBe(true);
    expect(result.config.ofapiDmSyncEnabled).toBe(true);
    expect(result.config.ofapiAccountHealthEnabled).toBe(true);
    expect(result.skipped).toEqual([]);
  });

  it("requires-graph fail-safe: reverts a dependent that is on while a prerequisite is off", () => {
    // dmSync requires dmProjection. A row turns dmSync ON while dmProjection stays env-off —
    // boot must NOT apply that invalid dependent=on/prereq=off graph: dmSync is reverted to
    // env (off) and recorded as skipped with a "prerequisite ... is off" reason.
    const config = baseConfig();
    const result = applyBootOverrides(config, overrides([["ofapiDmSyncEnabled", true]]));
    expect(result.config.ofapiDmSyncEnabled).toBe(false);
    // Nothing valid survived → original config identity.
    expect(result.config).toBe(config);
    const skip = result.skipped.find((s) => s.key === "ofapiDmSyncEnabled");
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/prerequisite ofapiDmProjectionEnabled is off/);
  });

  it("zero-override invalid ENV graph: forces a dependent OFF when env itself is dependent=on/prereq=off", () => {
    // The env config IS the invalid staged graph: dmSync=true while its prerequisite
    // dmProjection=false. With NO overrides at all, applyBootOverrides must still normalize
    // the boot graph and force dmSync OFF (not leave the env true), recording a reason.
    const config = {
      ...baseConfig(),
      ofapiDmProjectionEnabled: false,
      ofapiDmSyncEnabled: true,
    } as unknown as AppConfig;
    const result = applyBootOverrides(config, new Map());
    expect(result.config.ofapiDmSyncEnabled).toBe(false);
    expect(result.config.ofapiDmProjectionEnabled).toBe(false);
    // A real change vs env (env had dmSync=true) → the merged clone, not the identity.
    expect(result.config).not.toBe(config);
    const skip = result.skipped.find((s) => s.key === "ofapiDmSyncEnabled");
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/prerequisite ofapiDmProjectionEnabled is off/);
  });

  it("forces a dependent OFF (not to its env value) when the env dependent is itself true", () => {
    // env dmSync=true (the invalid value), prereq dmProjection env-off. An override turns
    // dmSync on again — the force-off must drive dmSync to FALSE, never back to its env
    // `true`. This is the bug the fix closes: reverting to env would re-apply the invalid on.
    const config = {
      ...baseConfig(),
      ofapiDmProjectionEnabled: false,
      ofapiDmSyncEnabled: true,
    } as unknown as AppConfig;
    const result = applyBootOverrides(config, overrides([["ofapiDmSyncEnabled", true]]));
    expect(result.config.ofapiDmSyncEnabled).toBe(false);
    const skip = result.skipped.find((s) => s.key === "ofapiDmSyncEnabled");
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/prerequisite ofapiDmProjectionEnabled is off/);
  });

  it("zero-override valid ENV graph returns the original config identity (no needless clone)", () => {
    // env is already a consistent boot graph (the full #49 chain on); with no overrides the
    // normalization changes nothing, so the original identity is handed back.
    const config = {
      ...baseConfig(),
      ofapiDmProjectionEnabled: true,
      ofapiDmSyncEnabled: true,
      ofapiAccountHealthEnabled: true,
    } as unknown as AppConfig;
    const result = applyBootOverrides(config, new Map());
    expect(result.config).toBe(config);
    expect(result.skipped).toEqual([]);
  });

  it("requires-graph fail-safe: reverts a deep dependent while keeping the satisfied prefix", () => {
    // dmProjection + dmSync overridden on (valid chain), but accountHealth left env-off while
    // creditLedger (#50, requires accountHealth) is overridden on. creditLedger must revert
    // (its prereq accountHealth is off); dmProjection + dmSync stay applied.
    const config = baseConfig();
    const result = applyBootOverrides(
      config,
      overrides([
        ["ofapiDmProjectionEnabled", true],
        ["ofapiDmSyncEnabled", true],
        ["ofapiCreditLedgerEnabled", true],
      ]),
    );
    expect(result.config.ofapiDmProjectionEnabled).toBe(true);
    expect(result.config.ofapiDmSyncEnabled).toBe(true);
    expect(result.config.ofapiCreditLedgerEnabled).toBe(false);
    const skip = result.skipped.find((s) => s.key === "ofapiCreditLedgerEnabled");
    expect(skip).toBeDefined();
    expect(skip!.reason).toMatch(/prerequisite ofapiAccountHealthEnabled is off/);
  });
});

describe("validateStagedTransition", () => {
  // Build a transition input where only the listed keys report a given running state and
  // desired-on baseline; every other boot key is running-off / desired-off by default.
  // `desiredOn` is the CURRENT DB-desired baseline (the override boolean, else env) the
  // handler computes — NOT the boot-applied config.
  function transition(
    patches: StagedPatchEntry[],
    opts?: { running?: Record<string, RunningFlagState>; desiredOn?: string[] },
  ) {
    const running = opts?.running ?? {};
    const desiredOnSet = new Set(opts?.desiredOn ?? []);
    return validateStagedTransition({
      patches,
      runningState: (key) => running[key] ?? "off",
      baselineDesiredOn: (key) => desiredOnSet.has(key),
    });
  }

  it("rejects enabling dmSync when its prerequisite dmProjection is running-off", () => {
    const result = transition([{ key: "ofapiDmSyncEnabled", desired: true }], {
      running: { ofapiDmProjectionEnabled: "off" },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ofapiDmProjectionEnabled");
      expect(result.error).toMatch(/restart/);
    }
  });

  it("allows enabling dmSync when its prerequisite dmProjection is running-on AND desired-on", () => {
    const result = transition([{ key: "ofapiDmSyncEnabled", desired: true }], {
      running: { ofapiDmProjectionEnabled: "on" },
      desiredOn: ["ofapiDmProjectionEnabled"],
    });
    expect(result).toEqual({ ok: true });
  });

  it("rejects enabling a dependent when its prerequisite is running-on but desired-off (reverted, not yet restarted)", () => {
    // The orphan window the fix closes: dmProjection was reverted/disabled in the DB (desired
    // off) but the un-restarted fleet still reports it running-on. Enabling dmSync against it
    // would persist a dependent-on/prereq-off desired graph, so it must be rejected even though
    // runningState(dmProjection) === 'on'.
    const result = transition([{ key: "ofapiDmSyncEnabled", desired: true }], {
      running: { ofapiDmProjectionEnabled: "on" },
      // desiredOn intentionally omitted → dmProjection desired-off.
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ofapiDmProjectionEnabled");
      expect(result.error).toMatch(/not desired-on|disabled|reverted/);
    }
  });

  it("rejects enabling a #50 flag while the #49 chain is not all running", () => {
    // ofapiCreditLedgerEnabled (#50,1) requires accountHealth, which transitively requires
    // dmSync + dmProjection. accountHealth running-on but dmSync only desired (not running).
    const result = transition([{ key: "ofapiCreditLedgerEnabled", desired: true }], {
      running: {
        ofapiDmProjectionEnabled: "on",
        ofapiDmSyncEnabled: "off",
        ofapiAccountHealthEnabled: "off",
      },
    });
    expect(result.ok).toBe(false);
  });

  it("rejects enabling prereq + dependent in the SAME patch (prereq not running yet)", () => {
    const result = transition([
      { key: "ofapiDmProjectionEnabled", desired: true },
      { key: "ofapiDmSyncEnabled", desired: true },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ofapiDmProjectionEnabled");
      expect(result.error).toMatch(/same patch/);
    }
  });

  it("allows enabling a leaf prerequisite (no requires) on its own", () => {
    const result = transition([{ key: "ofapiDmProjectionEnabled", desired: true }]);
    expect(result).toEqual({ ok: true });
  });

  it("rejects disabling a key while a live dependent stays desired-on (env-on)", () => {
    // dmProjection off, but dmSync is desired-on and not being changed → still depends on it.
    const result = transition([{ key: "ofapiDmProjectionEnabled", desired: false }], {
      desiredOn: ["ofapiDmSyncEnabled"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("ofapiDmSyncEnabled");
    }
  });

  it("uses the DB-desired baseline (not boot config): a staged-but-not-restarted override blocks the disable", () => {
    // The bypass this closes: dmSync was just staged ON in the DB (override) but NOT yet
    // restarted, so the boot-applied config still reads dmSync=off. Disabling its
    // prerequisite dmProjection must still be REJECTED because the DESIRED baseline (the DB
    // override) has dmSync on. baselineDesiredOn reflects the DB override, not boot config.
    const result = transition([{ key: "ofapiDmProjectionEnabled", desired: false }], {
      desiredOn: ["ofapiDmSyncEnabled"],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("ofapiDmSyncEnabled");
  });

  it("allows atomic disable of dependent + prerequisite together", () => {
    // Both desired-on; disabling both in one patch leaves no dependent desired-on.
    const result = transition(
      [
        { key: "ofapiDmSyncEnabled", desired: false },
        { key: "ofapiDmProjectionEnabled", desired: false },
      ],
      { desiredOn: ["ofapiDmProjectionEnabled", "ofapiDmSyncEnabled"] },
    );
    expect(result).toEqual({ ok: true });
  });

  it("rejects a non-boot key", () => {
    // logLevel is editable runtimeApply:'none'; transactionLookbackDays is live.
    expect(transition([{ key: "logLevel", desired: true }]).ok).toBe(false);
    expect(transition([{ key: "transactionLookbackDays", desired: true }]).ok).toBe(false);
    expect(transition([{ key: "nopeNotAKey", desired: true }]).ok).toBe(false);
  });

  it("rejects duplicate keys", () => {
    const result = transition([
      { key: "ofapiDmProjectionEnabled", desired: true },
      { key: "ofapiDmProjectionEnabled", desired: false },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/twice/);
  });
});
