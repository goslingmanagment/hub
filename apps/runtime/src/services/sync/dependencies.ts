import type { PageSyncDependencyOptions } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

export function pageSyncDependencyOptions(
  app: { config?: Pick<AppContext["config"], "ofapiDmSyncEnabled"> },
): PageSyncDependencyOptions | undefined {
  if (app.config?.ofapiDmSyncEnabled !== true) {
    return undefined;
  }

  return {
    onlyFansOfapiDmSyncEnabled: true,
  };
}

export function pageSyncDependencyInput(
  app: { config?: Pick<AppContext["config"], "ofapiDmSyncEnabled"> },
): { dependencyOptions?: PageSyncDependencyOptions } {
  const dependencyOptions = pageSyncDependencyOptions(app);
  return dependencyOptions ? { dependencyOptions } : {};
}
