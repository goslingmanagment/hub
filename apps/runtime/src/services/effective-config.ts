// Live effective-config provider (Stage B1). It overlays the editable reload-mode
// overrides that are ACTUALLY wired to a runtime read-site onto the boot AppConfig,
// so every wired read-site and the heartbeat both consume the same value. Keeping
// the overlay gated on LIVE_CONFIG_KEYS means a reload-mode key that is not yet
// wired (none in this batch) is never reported as "applied" — the heartbeat's
// `running` snapshot stays an honest reflection of what the process reads.
//
// The merge is split into a PURE helper (`applyEffectiveOverrides`) so the gating,
// clamping and source rules are unit-testable without a database; `loadEffectiveConfig`
// is the single impure entry point and performs exactly one getConfigOverrides read.

import type { ConfigOverrideRecord, Database } from "@agency_hub_core/db";
import { getConfigOverrides } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";
import { getDescriptor, validateConfigOverride } from "@agency_hub_core/shared";

/** The editable reload-mode keys whose runtime read-sites are wired in this batch.
 *  An override only takes live effect (and only counts as applied in the heartbeat)
 *  for a key in this set. Never widen without wiring the matching read-site. */
export const LIVE_CONFIG_KEYS = new Set<string>([
  "ofapiCreditAlertThreshold",
  "ofapiWebhookSilenceThresholdMinutes",
  "ofapiBurnAlertCreditsPerHour",
  "healthSyncLightMaxAgeMinutes",
  "healthSyncFollowerMaxAgeMinutes",
  "transactionLookbackDays",
  "transactionRescanCapDays",
  "ofapiDmReconcileIntervalMinutes",
]);

/** PURE overlay: clone `config` and, for each LIVE key that is editable + reload and
 *  has a (re-validated, clamped) override, write the validated value into the matching
 *  AppConfig field. Restart-mode, non-editable, and non-live keys are ignored so they
 *  never appear applied at runtime. Returns `config` unchanged when nothing applies. */
export function applyEffectiveOverrides(
  config: AppConfig,
  overrides: Map<string, ConfigOverrideRecord>,
): AppConfig {
  if (overrides.size === 0) {
    return config;
  }

  let merged: AppConfig | null = null;
  for (const key of LIVE_CONFIG_KEYS) {
    const override = overrides.get(key);
    if (override === undefined) continue;

    const descriptor = getDescriptor(key);
    if (!descriptor || descriptor.editability !== "editable" || descriptor.applyMode !== "reload") {
      continue;
    }
    if (descriptor.configField == null) continue;

    const validated = validateConfigOverride(key, override.value);
    if (!validated.ok) continue;

    merged ??= { ...config };
    (merged as unknown as Record<string, unknown>)[descriptor.configField as string] = validated.value;
  }

  return merged ?? config;
}

/** Load the live effective config: one getConfigOverrides read layered over the boot
 *  config via the pure overlay above. The heartbeat and every wired read-site call
 *  this so `running` == what the process actually consumes. */
export async function loadEffectiveConfig(db: Database, config: AppConfig): Promise<AppConfig> {
  const overrides = await getConfigOverrides(db);
  return applyEffectiveOverrides(config, overrides);
}
