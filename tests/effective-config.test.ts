import { describe, expect, it } from "vitest";

import { getDescriptor } from "@agency_hub_core/shared";
import type { AppConfig } from "@agency_hub_core/shared";
import type { ConfigOverrideRecord } from "@agency_hub_core/db";

import {
  applyEffectiveOverrides,
  LIVE_CONFIG_KEYS,
} from "../apps/runtime/src/services/effective-config.ts";

// A minimal AppConfig with just the fields the overlay can touch; the pure helper
// only reads/writes configField entries, so a partial object cast is sufficient and
// keeps the test free of the full env schema.
function baseConfig(): AppConfig {
  return {
    ofapiCreditAlertThreshold: 1000,
    ofapiWebhookSilenceThresholdMinutes: 720,
    ofapiBurnAlertCreditsPerHour: 300,
    healthSyncLightMaxAgeMinutes: 180,
    healthSyncFollowerMaxAgeMinutes: 1080,
    transactionLookbackDays: 7,
    transactionRescanCapDays: 30,
    ofapiDmReconcileIntervalMinutes: 360,
    // A runtimeApply:'none' editable key (must never be overlaid) and a boot/staged key.
    logLevel: "info",
    ofapiDmProjectionEnabled: false,
    // A runtimeApply:'none' editable key (must never be overlaid by the live overlay).
    ofapiDmDailyCreditBudget: 500,
    serviceEgressProxyUrl: "socks5://proxy.example.internal:1080",
    serviceEgressProxyUsername: "fake-service-user",
    serviceEgressProxyPassword: "fake-service-password",
    encryptionKey: Buffer.alloc(0),
  } as unknown as AppConfig;
}

function overrides(entries: Array<[string, string | number | boolean]>): Map<string, ConfigOverrideRecord> {
  return new Map(entries.map(([key, value], i) => [key, { value, version: i + 1 }]));
}

describe("applyEffectiveOverrides", () => {
  it("returns the same object when there are no overrides", () => {
    const config = baseConfig();
    expect(applyEffectiveOverrides(config, new Map())).toBe(config);
  });

  it("applies a live reload override into its configField", () => {
    const config = baseConfig();
    const merged = applyEffectiveOverrides(config, overrides([["transactionLookbackDays", 14]]));
    expect(merged.transactionLookbackDays).toBe(14);
    // Original is not mutated.
    expect(config.transactionLookbackDays).toBe(7);
  });

  it("applies multiple live keys at once", () => {
    const merged = applyEffectiveOverrides(
      baseConfig(),
      overrides([
        ["ofapiCreditAlertThreshold", 250],
        ["ofapiDmReconcileIntervalMinutes", 60],
      ]),
    );
    expect(merged.ofapiCreditAlertThreshold).toBe(250);
    expect(merged.ofapiDmReconcileIntervalMinutes).toBe(60);
  });

  it("clamps an out-of-range number to the descriptor min", () => {
    // healthSyncLightMaxAgeMinutes has min:1; a value below it clamps up.
    const merged = applyEffectiveOverrides(
      baseConfig(),
      overrides([["healthSyncLightMaxAgeMinutes", -5]]),
    );
    expect(merged.healthSyncLightMaxAgeMinutes).toBe(1);
  });

  it("ignores a runtimeApply:'none' editable key (logLevel)", () => {
    const merged = applyEffectiveOverrides(baseConfig(), overrides([["logLevel", "debug"]]));
    expect(merged.logLevel).toBe("info");
  });

  it("ignores a staged (runtimeApply:'boot') key", () => {
    const merged = applyEffectiveOverrides(
      baseConfig(),
      overrides([["ofapiDmProjectionEnabled", true]]),
    );
    expect(merged.ofapiDmProjectionEnabled).toBe(false);
  });

  it("ignores an editable key that is NOT in the live set (runtimeApply:'none')", () => {
    // ofapiDmDailyCreditBudget is editable but not wired to the live overlay.
    const merged = applyEffectiveOverrides(
      baseConfig(),
      overrides([["ofapiDmDailyCreditBudget", 999]]),
    );
    expect(merged.ofapiDmDailyCreditBudget).toBe(500);
  });

  it("ignores an invalid (non-integer) override value, leaving env in place", () => {
    const merged = applyEffectiveOverrides(
      baseConfig(),
      overrides([["transactionLookbackDays", 3.5]]),
    );
    expect(merged.transactionLookbackDays).toBe(7);
  });

  it("never overlays the boot-only service proxy tuple", () => {
    const config = baseConfig();
    const merged = applyEffectiveOverrides(
      config,
      overrides([
        ["serviceEgressProxyUrl", "socks5://other.example.internal:1080"],
        ["serviceEgressProxyUsername", "other-fake-user"],
        ["serviceEgressProxyPassword", "other-fake-password"],
      ]),
    );
    expect(merged.serviceEgressProxyUrl).toBe(config.serviceEgressProxyUrl);
    expect(merged.serviceEgressProxyUsername).toBe(config.serviceEgressProxyUsername);
    expect(merged.serviceEgressProxyPassword).toBe(config.serviceEgressProxyPassword);
  });
});

describe("LIVE_CONFIG_KEYS", () => {
  it("are all editable + runtimeApply 'live' in the registry", () => {
    for (const key of LIVE_CONFIG_KEYS) {
      const descriptor = getDescriptor(key);
      expect(descriptor, `descriptor for ${key}`).toBeDefined();
      expect(descriptor!.editability, key).toBe("editable");
      expect(descriptor!.runtimeApply, key).toBe("live");
    }
  });

  it("covers exactly the wired keys", () => {
    // W3.2 added ofapiQueuedCommandTtlMs (read live by the command sweep);
    // Decision #136 added the two fan-dossier keys (read per generation);
    // Decision #140 added the single time-bounded prompt-echo window;
    // the voice-notes lane added the seven ElevenLabs kill switches + budgets;
    // the Agent Read Plane added its five plane switches, the Fansly replay mode
    // and the retention-tiering gate (read per request / per cycle);
    // decision #202 added the hydration autopilot mode and its daily budget;
    // G5 slice 1 added the CAS dual-write canary bound (published to each
    // process by the heartbeat, which reads the live overlay anyway);
    // G5 slice 2 added the payload read mode, published the same way;
    // G5 slice 3c-1 added the pointer-only bound, published on the same beat;
    // WP-F1 added the six `stats_snapshot` keys — the ramp flag, its FAIL-CLOSED
    // page allowlist, the per-lane daily call budget (read per chunk, so a
    // budget flip must not need a deploy), the hourly-bucket switch, the hourly
    // backfill bound and the backfill continuation delay;
    // WP-F2 added the three `notifications` keys — the ramp flag, its
    // FAIL-CLOSED page allowlist and the per-lane daily call budget, all read
    // per chunk so a ramp on the lossy lane never waits for a deploy;
    // WP-F3 added the three `catalog` keys on the same template;
    // WP-F5 added FOUR — the ramp flag, its FAIL-CLOSED page allowlist, the
    // per-lane daily call budget and the re-walk cycle, which is live because
    // it re-aims a running first pass without a deploy;
    // WP-F7 added the three `payouts` keys on the WP-F3 template;
    // WP-F4 added FOUR — the ramp flag, its FAIL-CLOSED page allowlist, the
    // per-lane daily call budget (the ONE number a cap-raise step moves, and
    // the whole request-count enforcement on the highest-volume lane in the
    // system) and the long-tail cycle, live because it re-aims a running
    // round-robin without a deploy.
    expect(LIVE_CONFIG_KEYS.has("fanslyDmHeadCatchupPageAllowlist")).toBe(true);
    expect(LIVE_CONFIG_KEYS.size).toBe(61);
  });
});
