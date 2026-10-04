import type { Platform } from "@agency_hub_core/shared";

import { appPlatformRegistry, type AppPlatformRegistry } from "../../platforms/registry.ts";

// Where the Fansly Sync Engine ends (plan §12). Everything of a Fansly page is
// read by the engine in this directory; what is left outside it is the legacy
// page-sync executor (`services/sync/`: the minutely planner, the
// `sync.page.execute` queue, `page_sync_states` leases and the per-stream
// chunk handlers), and since step 4 it serves OnlyFans only (owner decision
// №13).
//
// The executor's platform set is not named here: it is what the platform
// registry declares. A platform whose adapter declares a legacy stream
// (`capabilities.streams`, each with its pull handler — the registry's
// conformance check) is served; one that declares none is not. Fansly declares
// none (step 4 S4-10) and `services/sync/` holds no Fansly handler, no Fansly
// error class and no import of the Fansly HTTP package
// (tests/sync-onlyfans-boundary.test.ts), so the set cannot grow by accident.
//
// The planner and the executor take the set from here, hand it to every
// page-sync query that seeds, schedules, lists or leases
// (`PageSyncPlatformScope`), and assert it on what those queries return before
// they wake or run a page (I21).

/** The platforms the legacy page-sync executor serves: those whose adapter
 *  declares a stream (OnlyFans only since step 4). */
export function legacyExecutorPlatforms(registry: AppPlatformRegistry = appPlatformRegistry): Platform[] {
  return registry.all().filter((adapter) => adapter.capabilities.streams.length > 0).map((adapter) => adapter.key);
}

/** Whether the legacy page-sync executor serves `platform`. */
export function isLegacyExecutorPlatform(
  platform: Platform,
  registry: AppPlatformRegistry = appPlatformRegistry,
): boolean {
  return legacyExecutorPlatforms(registry).includes(platform);
}

/** Who met a page across the boundary. */
export type LegacyExecutorSite = "planner" | "executor";

/** A page of a platform the legacy executor does not serve reached its planner
 *  or its executor. The page-sync queries are scoped to the same set, so this
 *  is a broken fence, never an owner's mistake: the pass stops before it wakes
 *  or runs the page. */
export class LegacyExecutorBoundaryError extends Error {
  readonly pageId: number;
  readonly platform: Platform;
  readonly site: LegacyExecutorSite;

  constructor(input: { pageId: number; platform: Platform; site: LegacyExecutorSite }) {
    super(
      `The legacy page-sync ${input.site} met page ${input.pageId} of platform ${input.platform}, `
        + "which the legacy executor does not serve",
    );
    this.name = "LegacyExecutorBoundaryError";
    this.pageId = input.pageId;
    this.platform = input.platform;
    this.site = input.site;
  }
}

/** Stop unless the legacy executor serves the page's platform. */
export function assertLegacyExecutorPage(
  page: { pageId: number; platform: Platform },
  site: LegacyExecutorSite,
  registry: AppPlatformRegistry = appPlatformRegistry,
): void {
  if (!isLegacyExecutorPlatform(page.platform, registry)) {
    throw new LegacyExecutorBoundaryError({ pageId: page.pageId, platform: page.platform, site });
  }
}
