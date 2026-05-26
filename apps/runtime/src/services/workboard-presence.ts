import type { WorkboardPresenceResponse } from "@agency_hub_core/contracts";
import {
  listWorkboardPresence,
  upsertFanPageExternalPresences,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import {
  buildFanslyFollowerPresenceSignals,
  FANSLY_RECENTLY_ACTIVE_WINDOW_MS,
} from "./fansly-presence.ts";
import { resolveFanslyPlatformAccountId } from "./fansly.ts";
import { resolveAccessibleFanslyPage } from "./fansly-page.ts";
import { resolvePageContext } from "./page-context.ts";
import { upsertHydratedFansForPage } from "./sync/fan-hydration.ts";

const PRESENCE_REFRESH_TTL_MS = 60_000;
const presenceRefreshByPageId = new Map<number, number>();

function serializeTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function serializePresenceBucket(
  rows: Awaited<ReturnType<typeof listWorkboardPresence>>,
): WorkboardPresenceResponse["activeNow"] {
  return {
    total: rows.total,
    items: rows.items.map((row) => ({
      fanId: row.fanId,
      fan: {
        platformUserId: row.platformUserId,
        pageAlias: row.pageAlias,
        username: row.username,
        displayName: row.displayName,
      },
      presence: {
        lastSeenAt: row.externalPresenceAt.toISOString(),
        observedAt: row.externalPresenceObservedAt.toISOString(),
        source: row.externalPresenceSource,
      },
      ltv: {
        creatorNetAmountMills: Number(row.creatorNetAmountMills),
      },
      isSubscriber: row.isSubscriber,
      platformConversationId: row.platformConversationId,
      lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
    })),
  };
}

export async function getWorkboardPresenceReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
): Promise<WorkboardPresenceResponse> {
  requireDashboardUser(principal);
  const page = await resolveAccessibleFanslyPage(app, principal, pageLabel, "Workboard presence");
  const pageContext = await resolvePageContext(app, pageLabel);
  if (pageContext.platform !== "fansly") {
    throw new Error("Expected Fansly page context");
  }
  const updatedAt = new Date();
  const lastSeenAfter = updatedAt.getTime() - FANSLY_RECENTLY_ACTIVE_WINDOW_MS;
  const platformAccountId = resolveFanslyPlatformAccountId(pageContext.page);
  const lastRefreshAt = presenceRefreshByPageId.get(page.id) ?? 0;
  const shouldRefresh = updatedAt.getTime() - lastRefreshAt >= PRESENCE_REFRESH_TTL_MS;

  let offset = 0;
  const limit = 100;

  while (shouldRefresh) {
    const response = await app.adapter.getFollowersPage(
      {
        session: pageContext.session,
        proxy: pageContext.proxy,
      },
      platformAccountId,
      {
        offset,
        limit,
        lastSeenAfter,
        minDelayMs: app.config.followerPageDelayMs,
      },
    );

    const accountIds = new Set(response.accounts.map((account) => account.id));
    const fallbackIds = response.items
      .map((follower) => follower.followerId)
      .filter((id) => !accountIds.has(id));
    const signals = buildFanslyFollowerPresenceSignals({
      followers: response.items,
      accounts: response.accounts,
      observedAt: updatedAt,
      now: updatedAt,
    });

    await app.db.transaction(async (dbTx) => {
      const fanMap = await upsertHydratedFansForPage(dbTx, {
        platformAccountId: page.id,
        accounts: response.accounts,
        fallbackIds,
      });

      await upsertFanPageExternalPresences(
        dbTx,
        signals.flatMap((signal) => {
          const fanId = fanMap.get(signal.platformUserId);
          return fanId ? [{
            fanId,
            platformAccountId: page.id,
            externalPresenceAt: signal.lastSeenAt,
            externalPresenceObservedAt: signal.observedAt,
            externalPresenceSource: signal.source,
          }] : [];
        }),
      );
    });

    if (response.done) {
      break;
    }

    offset += limit;
  }

  if (shouldRefresh) {
    presenceRefreshByPageId.set(page.id, updatedAt.getTime());
  }

  const [activeNow, recentlyActive] = await Promise.all([
    listWorkboardPresence(app.db, {
      platformAccountId: page.id,
      bucket: "active_now",
      now: updatedAt,
      limit: 20,
    }),
    listWorkboardPresence(app.db, {
      platformAccountId: page.id,
      bucket: "recently_active",
      now: updatedAt,
      limit: 20,
    }),
  ]);

  return {
    updatedAt: updatedAt.toISOString(),
    bestEffort: true,
    activeNow: serializePresenceBucket(activeNow),
    recentlyActive: serializePresenceBucket(recentlyActive),
  };
}
