import { setTimeout as delay } from "node:timers/promises";

import { reserveSyncProviderRateLimit } from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

export type SyncRateLimitScope = {
  provider: "fansly" | "onlyfans";
  scope: string;
  egressKey: string;
};

export function createSyncRateLimitWaiter(
  app: Pick<AppContext, "config" | "db">,
) {
  if (!app.config.syncSharedRateLimitEnabled) {
    return null;
  }

  return async (scopes: SyncRateLimitScope[]) => {
    if (scopes.length === 0) {
      return;
    }

    const scheduledAt = await reserveSyncProviderRateLimit(app.db, { scopes });
    const waitMs = scheduledAt.getTime() - Date.now();
    if (waitMs > 0) {
      await delay(waitMs);
    }
  };
}
