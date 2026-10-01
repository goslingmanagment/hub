import { platformHasLiveOverlay, readsFanslyLiveOverlay, type Platform } from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";

/**
 * Whether this page's chatter routes and AI kernel context read the live
 * overlay right now (`fanslyLiveOverlayReadPages`, a live key: the value in
 * force at this read, so `none` takes effect on the next request). Pages of a
 * platform without an overlay never read the config.
 */
export async function pageReadsLiveOverlay(
  app: Pick<AppContext, "db" | "config">,
  page: { label: string; platform: Platform },
): Promise<boolean> {
  if (!platformHasLiveOverlay(page.platform)) return false;
  return readsFanslyLiveOverlay(await loadEffectiveConfig(app.db, app.config), page);
}
