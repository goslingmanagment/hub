import {
  routeSchemas,
  type RevenueDailyTypedItem,
} from "@agency_hub_core/contracts";
import {
  countDistinctFansForPages,
  findPlatformFan,
  getRevenueBreakdownForScope,
  getRevenuePageTotals,
  listFanPageContexts,
  listFanTransactionsCrossPage,
  listFanTransactionsOnPage,
  listFollowerTotalsForPages,
  listRevenueDailyForPages,
  listRevenueUtcDailyForExactPeriod,
  listCurrentSubscriptionCountsForPages,
  listSubscriberTotalsForPages,
  listTransactionsForScope,
  listRevenuePages,
  listVisiblePages,
} from "@agency_hub_core/db";
import {
  millsToNumber,
  resolveBusinessDateRangeForPlatform,
  resolveRevenueBusinessDateRangeForPlatform,
  resolveRevenueComparisonPeriodBoundsForPlatform,
  resolveRevenuePeriodBoundsForPlatform,
  resolvePeriodBounds,
  millsFromInteger,
  UTC_TIME_ZONE,
  type Period,
  type Platform,
} from "@agency_hub_core/shared";

import { pageScopeFor } from "../../api/request-auth.ts";
import {
  canAccessPage,
  enforceRevenueRouteRoleScope,
  type AuthPrincipal,
} from "../../services/auth.ts";
import { listConnectionStatuses } from "../../services/connections.ts";
import { ForbiddenError, NotFoundError } from "../../services/errors.ts";
import {
  getOverviewRevenueReport,
  getPageRevenueReport,
  getPageSummary,
  getPageTransactionsReport,
  groupPageIdsByPlatform,
  serializeRawType,
  summarizeRevenueRows,
} from "../../services/reporting.ts";
import {
  getPageSpenderAutoListDetail,
  getPageSpenderAutoLists,
  getSpenderBatch,
  getSpenderDetail,
  getSpenderList,
  getSpenderSeries,
} from "../../services/spenders.ts";
import { getSyncStatusSummarySnapshot } from "../../services/sync-summary.ts";
import { buildOverallSyncUx } from "../../services/sync-ux.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

// Finance module (target §6.1): the canonical money module — transactions,
// revenue, spend rollups, reporting, spender views. Handlers relocated
// verbatim from server.ts; the four revenue routes also call
// enforceRevenueRouteRoleScope (dashboard session role only).

function serializePageMetric(value: number | null) {
  return {
    value,
    available: value !== null,
  };
}

/**
 * The two sides of a page's audience. A Fansly subscriber pays and a free fan
 * is a follower; an OnlyFans free fan subscribes at price 0, so one counter
 * would set the payers of one platform beside the free fans of the other.
 */
function pageAudience(
  page: { platform: string; subscriberCount: number | null; followerCount: number | null },
  counts: { paid: number; free: number } | undefined,
) {
  const counted = page.subscriberCount !== null;
  return {
    paidSubscriberCount: serializePageMetric(counted ? counts?.paid ?? 0 : null),
    freeAudienceCount: serializePageMetric(
      page.platform === "fansly" ? page.followerCount : counted ? counts?.free ?? 0 : null,
    ),
  };
}

type TransactionCoreRow = Awaited<ReturnType<typeof listFanTransactionsOnPage>>["items"][number];

/** A transaction's money fields on the wire; the raw-type rule reads `platform`. */
function serializeTransactionCore(platform: Platform, row: TransactionCoreRow) {
  return {
    transactionId: row.transactionId,
    rawType: serializeRawType(platform, row.rawType),
    canonicalType: row.canonicalType,
    transactionState: row.transactionState,
    amountMills: millsToNumber(row.amountMills),
    destinationAmountMills: millsToNumber(row.destinationAmountMills),
    netAmountMills: millsToNumber(row.netAmountMills),
    occurredAt: new Date(row.occurredAt).toISOString(),
    sourceUpdatedAt: row.sourceUpdatedAt ? new Date(row.sourceUpdatedAt).toISOString() : null,
  };
}

export function registerFinanceRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext } = ctx;
  const { requirePrincipal } = ctx.auth;

  /** 404 for an unknown page first, then 403 for a page outside the principal's scope. */
  async function requirePageAccess(principal: AuthPrincipal, pageLabel: string) {
    const page = await getPageSummary(appContext, pageLabel);
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }
    return page;
  }

  server.get("/api/v1/overview/revenue", {
    schema: routeSchemas.overviewRevenue,
  }, async (request) => {
    const now = request.query.windowAt ? new Date(request.query.windowAt) : new Date();
    const principal = await requirePrincipal(request);
    const query = request.query;
    const pageIds = pageScopeFor(principal);
    return getOverviewRevenueReport(appContext, {
      now,
      period: query.period,
      ...(query.period === "custom" ? { custom: { from: query.from, to: query.to } } : {}),
      // Деньги → Месяц: the month's income up to the ledger's cut.
      ...(query.period === "custom" && query.until !== undefined ? { until: new Date(query.until) } : {}),
      ...(pageIds === undefined ? {} : { pageIds }),
    });
  });

  server.get("/api/v1/pages/:pageLabel/revenue", {
    schema: routeSchemas.pageRevenue,
  }, async (request) => {
    const now = request.query.windowAt ? new Date(request.query.windowAt) : new Date();
    const principal = await requirePrincipal(request);
    const query = request.query;
    await requirePageAccess(principal, request.params.pageLabel);
    enforceRevenueRouteRoleScope(principal);
    return getPageRevenueReport(appContext, request.params.pageLabel, {
      now,
      period: query.period,
      ...(query.period === "custom" ? { custom: { from: query.from, to: query.to }, utcDays: query.utcDays === true } : {}),
    });
  });

  server.get("/api/v1/pages/:pageLabel/transactions", {
    schema: routeSchemas.pageTransactions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    await requirePageAccess(principal, request.params.pageLabel);
    enforceRevenueRouteRoleScope(principal);

    return getPageTransactionsReport(appContext, request.params.pageLabel, {
      limit: query.limit,
      offset: query.offset,
      type: query.type,
      state: query.state,
    });
  });

  server.get("/api/v1/pages/:pageLabel/spender-autolists", {
    schema: routeSchemas.pageSpenderAutoLists,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    await requirePageAccess(principal, request.params.pageLabel);
    return getPageSpenderAutoLists(appContext, request.params.pageLabel, request.query);
  });

  server.get("/api/v1/pages/:pageLabel/spender-autolists/:bucketKey", {
    schema: routeSchemas.pageSpenderAutoListDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    await requirePageAccess(principal, request.params.pageLabel);
    return getPageSpenderAutoListDetail(
      appContext,
      request.params.pageLabel,
      request.params.bucketKey,
      request.query,
    );
  });

  server.get("/api/v2/spenders", {
    schema: routeSchemas.spenders,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getSpenderList(appContext, principal, request.query);
  });

  server.get("/api/v2/spenders/:platform/:platformUserId", {
    schema: routeSchemas.spenderDetail,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getSpenderDetail(appContext, principal, request.params, request.query);
  });

  server.get("/api/v2/spenders/:platform/:platformUserId/series", {
    schema: routeSchemas.spenderSeries,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getSpenderSeries(appContext, principal, request.params, request.query);
  });

  server.post("/api/v2/spenders:batch", {
    schema: routeSchemas.spenderBatch,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    return getSpenderBatch(appContext, principal, request.body);
  });

  // GET /api/v1/overview
  server.get("/api/v1/overview", {
    schema: routeSchemas.overview,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const pageScope = pageScopeFor(principal);
    const pages = await listVisiblePages(appContext.db, pageScope);
    const pageIds = pages.map((p) => p.id);
    const modelSet = new Map<string, { slug: string; name: string }>();
    for (const p of pages) {
      modelSet.set(p.modelSlug, { slug: p.modelSlug, name: p.modelName });
    }
    const syncSnapshot = await getSyncStatusSummarySnapshot(appContext, {
      pageIds,
    });
    const syncByPageId = new Map(syncSnapshot.pages.map((page) => [page.pageId, page.syncUx]));
    const overallSyncUx = buildOverallSyncUx(syncSnapshot.pages.map((page) => page.syncUx));
    const connectionStatuses = await listConnectionStatuses(appContext, {
      ...(pageScope === undefined ? {} : { pageIds: pageScope }),
      pages,
      syncUxByPageId: syncByPageId,
    });
    const statusByPageId = new Map(connectionStatuses.map((c) => [c.id, c]));

    // Revenue 7d and 30d
    const groupedPageIds = groupPageIdsByPlatform(pages);
    const now = new Date();

    // Every platform's breakdown rows, summed once below (bigint: the grouping changes no total).
    const breakdown7d: Awaited<ReturnType<typeof getRevenueBreakdownForScope>> = [];
    const breakdown30d: Awaited<ReturnType<typeof getRevenueBreakdownForScope>> = [];
    const prevRev7d = { netEarningsMills: 0n };
    const prevRev30d = { netEarningsMills: 0n };

    for (const [platform, ids] of groupedPageIds) {
      const bounds7d = resolveRevenuePeriodBoundsForPlatform(platform, "7d", now);
      const bounds30d = resolveRevenuePeriodBoundsForPlatform(platform, "30d", now);
      const compBounds7d = resolveRevenueComparisonPeriodBoundsForPlatform(platform, "7d", now);
      const compBounds30d = resolveRevenueComparisonPeriodBoundsForPlatform(platform, "30d", now);
      const [rows7d, rows30d, compRows7d, compRows30d] = await Promise.all([
        getRevenueBreakdownForScope(appContext.db, { platform, pageIds: ids, period: bounds7d }),
        getRevenueBreakdownForScope(appContext.db, { platform, pageIds: ids, period: bounds30d }),
        compBounds7d ? getRevenueBreakdownForScope(appContext.db, { platform, pageIds: ids, period: compBounds7d }) : Promise.resolve([]),
        compBounds30d ? getRevenueBreakdownForScope(appContext.db, { platform, pageIds: ids, period: compBounds30d }) : Promise.resolve([]),
      ]);
      breakdown7d.push(...rows7d);
      breakdown30d.push(...rows30d);
      for (const r of compRows7d) {
        prevRev7d.netEarningsMills += millsFromInteger(r.netAmountMills);
      }
      for (const r of compRows30d) {
        prevRev30d.netEarningsMills += millsFromInteger(r.netAmountMills);
      }
    }
    const rev7d = summarizeRevenueRows(breakdown7d);
    const rev30d = summarizeRevenueRows(breakdown30d);

    function computeDeltaPct(current: bigint, previous: bigint): number | null {
      if (previous === 0n) return null;
      return Number(((current - previous) * 10000n) / (previous < 0n ? -previous : previous)) / 100;
    }

    // Per-page revenue (today, 7d, 30d)
    const pageTotalsToday = new Map<number, bigint>();
    const pageTotals7d = new Map<number, bigint>();
    const pageTotals30d = new Map<number, bigint>();
    for (const [platform, ids] of groupedPageIds) {
      const [ptToday, pt7d, pt30d] = await Promise.all([
        getRevenuePageTotals(appContext.db, {
          platform,
          pageIds: ids,
          period: resolveRevenuePeriodBoundsForPlatform(platform, "today", now),
        }),
        getRevenuePageTotals(appContext.db, {
          platform,
          pageIds: ids,
          period: resolveRevenuePeriodBoundsForPlatform(platform, "7d", now),
        }),
        getRevenuePageTotals(appContext.db, {
          platform,
          pageIds: ids,
          period: resolveRevenuePeriodBoundsForPlatform(platform, "30d", now),
        }),
      ]);
      for (const r of ptToday) pageTotalsToday.set(r.pageId, millsFromInteger(r.netEarningsMills));
      for (const r of pt7d) pageTotals7d.set(r.pageId, millsFromInteger(r.netEarningsMills));
      for (const r of pt30d) pageTotals30d.set(r.pageId, millsFromInteger(r.netEarningsMills));
    }

    const subscriptionCounts = new Map(
      (await listCurrentSubscriptionCountsForPages(appContext.db, pageIds)).map((row) => [row.pageId, row]),
    );

    // Per-page new subscribers today
    const pageNewSubsToday = new Map<number, number>();
    const todayBusinessDate = resolveBusinessDateRangeForPlatform("fansly", "today", now);
    const subscriberTotals = await listSubscriberTotalsForPages(appContext.db, {
      pageIds,
      fromBusinessDate: todayBusinessDate.from,
      toBusinessDate: todayBusinessDate.toExclusive,
    });
    for (const row of subscriberTotals) {
      pageNewSubsToday.set(row.pageId, row.newSubscribers);
    }

    // Per-page new followers today
    const pageNewFollowersToday = new Map<number, number>();
    const followerTotals = await listFollowerTotalsForPages(appContext.db, {
      pageIds,
      fromBusinessDate: todayBusinessDate.from,
      toBusinessDate: todayBusinessDate.toExclusive,
    });
    for (const row of followerTotals) {
      pageNewFollowersToday.set(row.pageId, row.newFollowers);
    }
    const distinctFans = await countDistinctFansForPages(appContext.db, pageIds);

    return {
      counts: {
        models: modelSet.size,
        pages: pages.length,
        fans: distinctFans,
      },
      revenue: {
        "7d": {
          revenueMills: millsToNumber(rev7d.revenueMills),
          adjustmentMills: millsToNumber(rev7d.adjustmentMills),
          unclassifiedMills: millsToNumber(rev7d.unclassifiedMills),
          netEarningsMills: millsToNumber(rev7d.netEarningsMills),
          previousNetEarningsMills: millsToNumber(prevRev7d.netEarningsMills),
          deltaPct: computeDeltaPct(rev7d.netEarningsMills, prevRev7d.netEarningsMills),
        },
        "30d": {
          revenueMills: millsToNumber(rev30d.revenueMills),
          adjustmentMills: millsToNumber(rev30d.adjustmentMills),
          unclassifiedMills: millsToNumber(rev30d.unclassifiedMills),
          netEarningsMills: millsToNumber(rev30d.netEarningsMills),
          previousNetEarningsMills: millsToNumber(prevRev30d.netEarningsMills),
          deltaPct: computeDeltaPct(rev30d.netEarningsMills, prevRev30d.netEarningsMills),
        },
      },
      overall: {
        syncUx: overallSyncUx,
      },
      pages: pages.map((p) => {
        const status = statusByPageId.get(p.id);
        return {
          id: p.id,
          label: p.label,
          platform: p.platform,
          modelSlug: p.modelSlug,
          modelName: p.modelName,
          username: p.username,
          subscriberCount: serializePageMetric(p.subscriberCount),
          followerCount: serializePageMetric(p.followerCount),
          ...pageAudience(p, subscriptionCounts.get(p.id)),
          revenueTodayMills: millsToNumber(pageTotalsToday.get(p.id) ?? 0n),
          revenue7dMills: millsToNumber(pageTotals7d.get(p.id) ?? 0n),
          revenue30dMills: millsToNumber(pageTotals30d.get(p.id) ?? 0n),
          newSubscribersToday: pageNewSubsToday.get(p.id) ?? 0,
          newFollowersToday: pageNewFollowersToday.get(p.id) ?? 0,
          connectionStatus: status?.connectionStatus ?? "unverified",
          lastLightSyncAt: p.lastLightSyncAt?.toISOString() ?? null,
          lastFollowerSyncAt: p.lastFollowerSyncAt?.toISOString() ?? null,
          lastSyncError: status?.lastSyncError ?? null,
          syncUx: syncByPageId.get(p.id) ?? overallSyncUx,
        };
      }),
      setup: {
        hasPages: pages.length > 0,
        hasFanslyPages: pages.some((p) => p.platform === "fansly"),
        hasOnlyFansPages: pages.some((p) => p.platform === "onlyfans"),
      },
    };
  });

  // Revenue daily endpoints
  async function getRevenueDailySeries(
    pages: Array<{ id: number; platform: Platform }>,
    query: { period: string; from?: string | undefined; to?: string | undefined; groupByType: boolean; utcDays?: boolean | undefined },
    now: Date,
  ) {
    type RevenueDailyCanonicalType = RevenueDailyTypedItem["canonicalType"];
    const custom = query.period === "custom" && query.from && query.to
      ? { from: query.from, to: query.to }
      : undefined;

    // Fansly's UTC days, set beside its statistics: read from the transactions,
    // since the rollup is dated in Moscow days.
    if (query.utcDays) {
      const rows = await listRevenueUtcDailyForExactPeriod(appContext.db, {
        pageIds: pages.map((page) => page.id),
        period: resolvePeriodBounds(query.period as Period, now, custom, UTC_TIME_ZONE),
        groupByType: query.groupByType,
      }) as Array<{ businessDate: string; canonicalType?: RevenueDailyCanonicalType; netAmountMills: bigint; transactionCount: number }>;
      return {
        series: rows.map((row) => ({
          businessDate: row.businessDate,
          ...(row.canonicalType ? { canonicalType: row.canonicalType } : {}),
          netAmountMills: millsToNumber(row.netAmountMills),
          transactionCount: row.transactionCount,
        })),
      };
    }
    const groupedPageIds = groupPageIdsByPlatform(pages);

    const mergedResults = new Map<string, {
      businessDate: string;
      canonicalType?: RevenueDailyCanonicalType;
      netAmountMills: bigint;
      transactionCount: number;
    }>();

    for (const [platform, ids] of groupedPageIds) {
      const range = resolveRevenueBusinessDateRangeForPlatform(
        platform,
        query.period as Period,
        now,
        custom,
      );
      const rows = await listRevenueDailyForPages(appContext.db, {
        pageIds: ids,
        fromBusinessDate: range.from,
        toBusinessDate: range.toExclusive,
        groupByType: query.groupByType,
      }) as Array<{
        businessDate: string;
        canonicalType?: RevenueDailyCanonicalType;
        netAmountMills: bigint;
        transactionCount: number;
      }>;

      for (const row of rows) {
        const key = query.groupByType ? `${row.businessDate}:${row.canonicalType}` : row.businessDate;
        const current = mergedResults.get(key);
        if (current) {
          current.netAmountMills += row.netAmountMills;
          current.transactionCount += row.transactionCount;
          continue;
        }

        mergedResults.set(key, {
          businessDate: row.businessDate,
          ...(query.groupByType ? { canonicalType: row.canonicalType } : {}),
          netAmountMills: row.netAmountMills,
          transactionCount: row.transactionCount,
        });
      }
    }

    return {
      series: Array.from(mergedResults.values())
        .sort((left, right) => {
          const dateCompare = left.businessDate.localeCompare(right.businessDate);
          if (dateCompare !== 0) {
            return dateCompare;
          }
          return (left.canonicalType ?? "").localeCompare(right.canonicalType ?? "");
        })
        .map((row) => ({
          businessDate: row.businessDate,
          ...(row.canonicalType ? { canonicalType: row.canonicalType } : {}),
          netAmountMills: millsToNumber(row.netAmountMills),
          transactionCount: row.transactionCount,
        })),
    };
  }

  server.get("/api/v1/overview/revenue/daily", {
    schema: routeSchemas.overviewRevenueDaily,
  }, async (request) => {
    const now = request.query.windowAt ? new Date(request.query.windowAt) : new Date();
    const principal = await requirePrincipal(request);
    const pages = await listRevenuePages(appContext.db, pageScopeFor(principal));
    return getRevenueDailySeries(
      pages,
      request.query,
      now,
    );
  });

  server.get("/api/v1/pages/:pageLabel/revenue/daily", {
    schema: routeSchemas.pageRevenueDaily,
  }, async (request) => {
    const now = request.query.windowAt ? new Date(request.query.windowAt) : new Date();
    const principal = await requirePrincipal(request);
    const page = await requirePageAccess(principal, request.params.pageLabel);
    enforceRevenueRouteRoleScope(principal);
    return getRevenueDailySeries([page], request.query, now);
  });

  server.get("/api/v1/models/:modelSlug/revenue/daily", {
    schema: routeSchemas.modelRevenueDaily,
  }, async (request) => {
    const now = request.query.windowAt ? new Date(request.query.windowAt) : new Date();
    const principal = await requirePrincipal(request);
    const pages = (await listRevenuePages(appContext.db, pageScopeFor(principal)))
      .filter((p) => p.modelSlug === request.params.modelSlug);
    if (pages.length === 0) {
      throw new NotFoundError(`Model "${request.params.modelSlug}" not found`);
    }
    return getRevenueDailySeries(pages, request.query, now);
  });

  // Cross-page transactions
  server.get("/api/v1/transactions", {
    schema: routeSchemas.crossPageTransactions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const query = request.query;
    const pageScope = pageScopeFor(principal);
    const allPages = await listRevenuePages(appContext.db, pageScope);
    const pageIds = pageScope ?? allPages.map((p) => p.id);

    const result = await listTransactionsForScope(appContext.db, {
      pageIds,
      ...(query.pageLabel === undefined ? {} : { pageLabel: query.pageLabel }),
      period: { from: query.from ? new Date(query.from) : null, to: query.to ? new Date(query.to) : null },
      reportableOnly: query.reportableOnly,
      ...(query.type === undefined ? {} : { canonicalType: query.type }),
      ...(query.state === undefined ? {} : { transactionState: query.state }),
      sortBy: query.sortBy,
      sortDir: query.sortDir,
      limit: query.limit,
      offset: query.offset,
    });

    return {
      items: result.items.map((row) => ({
        ...serializeTransactionCore(row.platform, row),
        fan: row.fanPlatformUserId
          ? { platformUserId: row.fanPlatformUserId, username: row.fanUsername, displayName: row.fanDisplayName }
          : null,
        pageLabel: row.pageLabel,
        platform: row.platform,
      })),
      limit: query.limit,
      offset: query.offset,
      total: result.total,
      summary: { netAmountMills: millsToNumber(result.netAmountMills), currency: "USD" as const, readAt: result.readAt.toISOString() },
      scope: {
        pageLabel: query.pageLabel ?? null,
        from: query.from ? new Date(query.from).toISOString() : null,
        to: query.to ? new Date(query.to).toISOString() : null,
        type: query.type ?? null,
        state: query.state ?? null,
        reportableOnly: query.reportableOnly,
      },
    };
  });

  // Fan transactions on page
  server.get("/api/v1/pages/:pageLabel/fans/:platformUserId/transactions", {
    schema: routeSchemas.pageFanTransactions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const page = await requirePageAccess(principal, request.params.pageLabel);
    enforceRevenueRouteRoleScope(principal);
    const fan = await findPlatformFan(appContext.db, page.platform, request.params.platformUserId);
    if (!fan) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const result = await listFanTransactionsOnPage(appContext.db, {
      pageId: page.id,
      fanId: fan.id,
      limit: request.query.limit,
      offset: request.query.offset,
    });
    return {
      items: result.items.map((row) => ({
        ...serializeTransactionCore(page.platform, row),
      })),
      limit: request.query.limit,
      offset: request.query.offset,
      total: result.total,
    };
  });

  // Cross-page fan transactions
  server.get("/api/v1/fans/:platform/:platformUserId/transactions", {
    schema: routeSchemas.crossPageFanTransactions,
  }, async (request) => {
    const principal = await requirePrincipal(request);
    const fan = await findPlatformFan(appContext.db, request.params.platform, request.params.platformUserId);
    if (!fan) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const fanPages = await listFanPageContexts(appContext.db, fan.id, pageScopeFor(principal));
    if (fanPages.length === 0) {
      throw new NotFoundError(`Fan "${request.params.platformUserId}" not found`);
    }
    const memberPageIds = fanPages.map((p) => p.pageId);
    const result = await listFanTransactionsCrossPage(appContext.db, {
      fanId: fan.id,
      pageIds: memberPageIds,
      limit: request.query.limit,
      offset: request.query.offset,
    });
    return {
      items: result.items.map((row) => ({
        ...serializeTransactionCore(row.platform, row),
        pageLabel: row.pageLabel,
        platform: row.platform,
      })),
      limit: request.query.limit,
      offset: request.query.offset,
      total: result.total,
    };
  });
}
