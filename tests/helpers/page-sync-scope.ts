import type { PageSyncPlatformScope } from "@agency_hub_core/db";

/**
 * Every platform: the scope of the tests that drive the generic page-sync
 * machinery (leases, fencing, cool-downs, starvation, tombstones) on whatever
 * platform their fixture page has. Production never passes it: the planner
 * and the executor pass the legacy executor's own set
 * (`legacyExecutorPlatforms()`, OnlyFans only) — since step 4 (S4-21) the one
 * fence between that executor and a Fansly page.
 */
export const EVERY_PLATFORM: PageSyncPlatformScope = ["fansly", "onlyfans"];
