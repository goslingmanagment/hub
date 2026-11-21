import { customTierOverridesOf, type CustomTierOverride } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import { loadEffectiveConfigField } from "../effective-config.ts";

/**
 * Custom orders that keep themselves true (customs facts spec C9): the owner's live switch `customsFacts` (off by
 * default) and the correction of which tiers include a custom (`customTierOverrides`). Every new automatic behaviour of
 * the custom orders — the exact «given», the default deadline, the findings, their matters — runs only while the switch
 * is on; the board's read-time fields do not wait for it.
 */
type SwitchApp = Pick<AppContext, "db" | "config">;

export async function customsFactsOn(app: SwitchApp): Promise<boolean> {
  return (await loadEffectiveConfigField(app.db, app.config, "customsFacts")) === true;
}

export async function customTierOverridesNow(app: SwitchApp): Promise<CustomTierOverride[]> {
  return customTierOverridesOf(await loadEffectiveConfigField(app.db, app.config, "customTierOverrides"));
}
