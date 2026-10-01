import {
  ensureSyncProviderRateLimitProfile,
  reserveSyncProviderRateLimit,
} from "@agency_hub_core/db";
import { assertHttpRequestActive, waitForHttpRequestDelay } from "@agency_hub_core/shared";

import type { AppContext } from "../../bootstrap.ts";
import type { ResolvedPageContext } from "../page-context.ts";

export type SyncRateLimitScope = {
  provider: "fansly" | "onlyfans";
  scope: string;
};

export function createSyncRateLimitWaiter(
  app: Pick<AppContext, "config" | "db">,
  input: { egressKey: string; holdMs?: number },
): ((scopes: SyncRateLimitScope[]) => Promise<number>) | null {
  if (!app.config.syncSharedRateLimitEnabled) {
    return null;
  }

  const ensuredProviders = new Map<"fansly" | "onlyfans", Promise<void>>();

  return async (scopes: SyncRateLimitScope[]) => {
    assertHttpRequestActive();
    if (scopes.length === 0) {
      return 0;
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

    assertHttpRequestActive();
    const scheduledAt = await reserveSyncProviderRateLimit(app.db, {
      scopes: scopes.map((scope) => ({
        ...scope,
        egressKey: input.egressKey,
      })),
      ...(input.holdMs !== undefined ? { holdMs: input.holdMs } : {}),
    });
    const waitMs = Math.max(0, scheduledAt.getTime() - Date.now());
    assertHttpRequestActive();
    if (waitMs > 0) {
      await waitForHttpRequestDelay(waitMs);
    }

    return waitMs;
  };
}

/** The waiter every executor chunk builds for the legacy endpoint pauses: the
 *  page's own egress key is their identity, so two pages sharing a proxy share
 *  those queues. The page-wide spacing is the page's send guard. */
export function createPageRateLimitWaiter(
  app: AppContext,
  pageContext: ResolvedPageContext,
) {
  return createSyncRateLimitWaiter(app, {
    egressKey: pageContext.egressKey,
  });
}

async function ensureProviderRateLimitProfile(
  app: Pick<AppContext, "config" | "db">,
  input: {
    provider: "fansly" | "onlyfans";
    egressKey: string;
  },
) {
  if (input.provider === "fansly") {
    // The endpoint pauses only. The page-wide spacing (the former `global`
    // scope, S + 100 ms per egress) is the per-page send guard now (plan §2.5);
    // these scopes go once the guard has passed its acceptance.
    await ensureSyncProviderRateLimitProfile(app.db, {
      provider: "fansly",
      egressKey: input.egressKey,
      scopes: [
        { scope: "followers_page", minSpacingMs: app.config.followerPageDelayMs },
        { scope: "dm_conversations", minSpacingMs: app.config.fanslyDmConversationsDelayMs },
        { scope: "dm_messages", minSpacingMs: app.config.fanslyDmMessagesDelayMs },
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
