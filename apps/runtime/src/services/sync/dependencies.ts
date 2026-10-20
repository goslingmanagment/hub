import type { PageSyncDependencyOptions } from "@agency_hub_core/db";

// OnlyFans DM sync always runs through OFAPI, so the page-sync dependency
// graph always takes its OFAPI shape.
const PAGE_SYNC_DEPENDENCY_OPTIONS: PageSyncDependencyOptions = {
  onlyFansOfapiDmSyncEnabled: true,
};

export function pageSyncDependencyInput(): { dependencyOptions: PageSyncDependencyOptions } {
  return { dependencyOptions: PAGE_SYNC_DEPENDENCY_OPTIONS };
}
