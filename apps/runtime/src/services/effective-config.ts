// Live effective-config provider (Stage B1). It overlays the overrides that are
// ACTUALLY wired to a runtime read-site (`runtimeApply === 'live'` in the registry)
// onto the boot AppConfig, so every wired read-site and the heartbeat both consume
// the same value. Gating the overlay on the live set means a key that is not yet
// wired (boot/none) is never reported as "applied" — the heartbeat's `running`
// snapshot stays an honest reflection of what the process reads.
//
// The merge is split into a PURE helper (`applyEffectiveOverrides`) so the gating,
// clamping and source rules are unit-testable without a database; `loadEffectiveConfig`
// is the single impure entry point and performs exactly one getConfigOverrides read.

import type { ConfigOverrideRecord, Database } from "@agency_hub_core/db";
import { getConfigOverrides } from "@agency_hub_core/db";
import type { AppConfig } from "@agency_hub_core/shared";
import { CONFIG_DESCRIPTORS, getDescriptor, validateConfigOverride } from "@agency_hub_core/shared";

/** The keys wired to the live runtime overlay, DERIVED from the registry as exactly the
 *  descriptors with `runtimeApply === 'live'` — the single source of truth. An override
 *  only takes live effect (and only counts as applied in the heartbeat) for a key in
 *  this set. Widen by flipping a descriptor to 'live' (and wiring its read-site), not by
 *  editing a hardcoded list. Kept exported as a Set for its existing consumers. */
export const LIVE_CONFIG_KEYS = new Set<string>(
  CONFIG_DESCRIPTORS.filter((descriptor) => descriptor.runtimeApply === "live").map((d) => d.key),
);

/** PURE overlay: clone `config` and, for each `runtimeApply === 'live'` key that has a
 *  (re-validated, clamped) override, write the validated value into the matching
 *  AppConfig field. An override the validator rejects — including a hand-written
 *  out-of-range value of an `outOfRange: 'reject'` key such as the Fansly pause — is
 *  skipped, so the env value stays. Boot-mode and non-overridable (none) keys are ignored
 *  so they never appear applied via the live overlay. Returns `config` unchanged when
 *  nothing applies. */
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
    if (!descriptor || descriptor.runtimeApply !== "live") {
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
