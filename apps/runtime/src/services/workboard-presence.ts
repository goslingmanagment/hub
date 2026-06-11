import type { WorkboardPresenceResponse } from "@agency_hub_core/contracts";
import {
  findPageById,
  findPageSummaryByLabel,
  listWorkboardPresence,
  upsertFanPageExternalPresences,
} from "@agency_hub_core/db";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, requireDashboardUser, type AuthPrincipal } from "./auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.ts";
import {
  buildFanslyFollowerPresenceSignals,
  FANSLY_RECENTLY_ACTIVE_WINDOW_MS,
} from "./fansly-presence.ts";
import { resolveFanslyPlatformAccountId } from "./fansly.ts";
import { isOfapiPresenceProjectionEnabled } from "./ofapi-presence-projection.ts";
import { resolvePageContext, type ResolvedFanslyPageContext } from "./page-context.ts";
import { upsertHydratedFansForPage } from "./sync/fan-hydration.ts";

const PRESENCE_REFRESH_TTL_MS = 60_000;
// Hard cap on follower pages fetched per refresh. Guards against an adapter that
// never reports `done`, which would otherwise loop (and increment offset)
// forever. At 100 followers/page this covers 100k followers.
const PRESENCE_REFRESH_MAX_PAGES = 1_000;
const presenceRefreshByPageId = new Map<number, number>();
// In-flight refreshes keyed by pageId so two near-simultaneous requests for the
// same page coalesce onto a single pass instead of both entering the loop.
const presenceRefreshInFlightByPageId = new Map<number, Promise<void>>();

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

async function refreshPresenceForPage(
  app: AppContext,
  pageContext: ResolvedFanslyPageContext,
  pageId: number,
  platformAccountId: string,
  updatedAt: Date,
  lastSeenAfter: number,
): Promise<void> {
  let offset = 0;
  const limit = 100;

  for (let page = 0; page < PRESENCE_REFRESH_MAX_PAGES; page += 1) {
    const response = await app.adapter.getFollowersPage(
      {
        session: pageContext.session,
        proxy: pageContext.proxy,
        egressKey: pageContext.egressKey,
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
        platformAccountId: pageId,
        accounts: response.accounts,
        fallbackIds,
      });

      await upsertFanPageExternalPresences(
        dbTx,
        signals.flatMap((signal) => {
          const fanId = fanMap.get(signal.platformUserId);
          return fanId ? [{
            fanId,
            platformAccountId: pageId,
            externalPresenceAt: signal.lastSeenAt,
            externalPresenceObservedAt: signal.observedAt,
            externalPresenceSource: signal.source,
          }] : [];
        }),
      );
    });

    if (response.done) {
      return;
    }

    offset += limit;
  }

  app.logger.warn(
    { pageId, maxPages: PRESENCE_REFRESH_MAX_PAGES },
    "Workboard presence refresh hit page cap before adapter reported done; truncating",
  );
}

export async function getWorkboardPresenceReport(
  app: AppContext,
  principal: AuthPrincipal,
  pageLabel: string,
): Promise<WorkboardPresenceResponse> {
  requireDashboardUser(principal);
  const page = await findPageSummaryByLabel(app.db, pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${pageLabel}" was not found`);
  }
  if (!canAccessPage(principal, page.id)) {
    throw new ForbiddenError();
  }

  if (page.platform === "onlyfans") {
    // D9: OnlyFans presence is DB-read-only — the webhook projection keeps the
    // store fresh, so refresh is a no-op (and no platform credentials are
    // required, unlike the Fansly refresh path). Pages outside the OFAPI
    // presence pipeline keep the historical Fansly-only rejection.
    const storedPage = await findPageById(app.db, page.id);
    const eligible = isOfapiPresenceProjectionEnabled(app.config) &&
      typeof storedPage?.page.ofapiAccountId === "string" &&
      storedPage.page.ofapiAccountId.length > 0;
    if (!eligible) {
      throw new BadRequestError("Workboard presence is only supported for Fansly pages");
    }
    return readStoredPresence(app, page.id, new Date());
  }

  const pageContext = await resolvePageContext(app, pageLabel);
  if (pageContext.platform !== "fansly") {
    throw new BadRequestError("Workboard presence is only supported for Fansly pages");
  }
  const updatedAt = new Date();
  const lastSeenAfter = updatedAt.getTime() - FANSLY_RECENTLY_ACTIVE_WINDOW_MS;
  const platformAccountId = resolveFanslyPlatformAccountId(pageContext.page);
  const lastRefreshAt = presenceRefreshByPageId.get(page.id) ?? 0;
  const shouldRefresh = updatedAt.getTime() - lastRefreshAt >= PRESENCE_REFRESH_TTL_MS;

  if (shouldRefresh) {
    // Coalesce concurrent refreshes for the same page: if one is already in
    // flight, await it instead of launching a second pagination pass.
    let inFlight = presenceRefreshInFlightByPageId.get(page.id);
    if (!inFlight) {
      inFlight = refreshPresenceForPage(
        app,
        pageContext,
        page.id,
        platformAccountId,
        updatedAt,
        lastSeenAfter,
      )
        .then(() => {
          presenceRefreshByPageId.set(page.id, updatedAt.getTime());
        })
        .finally(() => {
          presenceRefreshInFlightByPageId.delete(page.id);
        });
      presenceRefreshInFlightByPageId.set(page.id, inFlight);
    }
    await inFlight;
  }

  return readStoredPresence(app, page.id, updatedAt);
}

async function readStoredPresence(
  app: AppContext,
  pageId: number,
  updatedAt: Date,
): Promise<WorkboardPresenceResponse> {
  const [activeNow, recentlyActive] = await Promise.all([
    listWorkboardPresence(app.db, {
      platformAccountId: pageId,
      bucket: "active_now",
      now: updatedAt,
      limit: 20,
    }),
    listWorkboardPresence(app.db, {
      platformAccountId: pageId,
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
