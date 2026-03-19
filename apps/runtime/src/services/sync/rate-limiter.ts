import { setTimeout as delay } from "node:timers/promises";

import {
  ensureSyncProviderRateLimitProfile,
  reserveSyncProviderRateLimit,
} from "@agency_hub_core/db";

import type { AppContext } from "../../bootstrap.ts";

export type SyncRateLimitScope = {
  provider: "fansly" | "onlyfans";
  scope: string;
};

export function createSyncRateLimitWaiter(
  app: Pick<AppContext, "config" | "db">,
  input: { egressKey: string },
): ((scopes: SyncRateLimitScope[]) => Promise<void>) | null {
  if (!app.config.syncSharedRateLimitEnabled) {
    return null;
  }

  const ensuredProviders = new Map<"fansly" | "onlyfans", Promise<void>>();

  return async (scopes: SyncRateLimitScope[]) => {
    if (scopes.length === 0) {
      return;
    }

    const providers = Array.from(new Set(scopes.map((scope) => scope.provider)));

    await Promise.all(providers.map(async (provider) => {
      let ensurePromise = ensuredProviders.get(provider);
      if (!ensurePromise) {
        ensurePromise = ensureProviderRateLimitProfile(app, {
          provider,
          egressKey: input.egressKey,
        }).catch((error) => {
          ensuredProviders.delete(provider);
          throw error;
        });
        ensuredProviders.set(provider, ensurePromise);
      }

      await ensurePromise;
    }));

    const scheduledAt = await reserveSyncProviderRateLimit(app.db, {
      scopes: scopes.map((scope) => ({
        ...scope,
        egressKey: input.egressKey,
      })),
    });
    const waitMs = scheduledAt.getTime() - Date.now();
    if (waitMs > 0) {
      await delay(waitMs);
    }
  };
}

async function ensureProviderRateLimitProfile(
  app: Pick<AppContext, "config" | "db">,
  input: {
    provider: "fansly" | "onlyfans";
    egressKey: string;
  },
) {
  if (input.provider === "fansly") {
    await ensureSyncProviderRateLimitProfile(app.db, {
      provider: "fansly",
      egressKey: input.egressKey,
      scopes: [
        { scope: "global", minSpacingMs: app.config.fanslyDefaultDelayMs + 100 },
        { scope: "followers_page", minSpacingMs: app.config.followerPageDelayMs },
        { scope: "dm_conversations", minSpacingMs: 5000 },
        { scope: "dm_messages", minSpacingMs: 7500 },
      ],
    });
    return;
  }

  await ensureSyncProviderRateLimitProfile(app.db, {
    provider: "onlyfans",
    egressKey: input.egressKey,
    scopes: [
      { scope: "global", minSpacingMs: app.config.onlyFansDefaultDelayMs },
    ],
  });
}
