import {
  type AssignedPage,
  type CrossPageFanDetailResponse,
  type FanListQuery,
  type FanListResponse,
  type FollowerDailyResponse,
  type FollowerListResponse,
  type ModelListItem,
  type ModelRevenueResponse,
  type OverviewRevenueResponse,
  type PageFanDetailResponse,
  type PageRevenueResponse,
  type SubscriberDailyResponse,
  type SubscriberListResponse,
  type TransactionListQuery,
  type TransactionListResponse,
} from "@fansly-connect/contracts";
import {
  findFanOnPage,
  findPageSummaryByLabel,
  findPlatformFan,
  findVisibleModel,
  getFanSpendByIdentifier,
  getPlatformTotalSpendForFan,
  getRevenueBreakdown,
  getRevenueBreakdownForScope,
  getRevenuePageTotals,
  listFansForPage,
  listFollowerDailyForPage,
  listFollowersForPage,
  listFanPageContexts,
  listSubscribersForPage,
  listSubscriberDailyForPage,
  listTransactionsForPage,
  listVisibleModels,
  listVisiblePages,
  listFanFlags,
  listFanNotesForPages,
  listFanSummariesForPages,
} from "@fansly-connect/db";
import {
  millsToNumber,
  resolveBusinessDateRange,
  resolveRevenueComparisonPeriodBoundsForPlatform,
  resolveRevenuePeriodBoundsForPlatform,
  toMills,
  type PeriodBounds,
  type Period,
  type Platform,
} from "@fansly-connect/shared";

import type { AppContext } from "../bootstrap.ts";
import { NotFoundError } from "./errors.ts";

type PeriodInput = {
  period: Period;
  custom?: { from: string; to: string };
  now?: Date;
};

type RevenueWindowBase = Omit<PageRevenueResponse, "page" | "comparison">;
type RevenueWindow = RevenueWindowBase & Pick<PageRevenueResponse, "comparison">;
type RevenueBreakdownRow = {
  canonicalType: RevenueWindowBase["breakdown"][number]["canonicalType"];
  bucket: RevenueWindowBase["breakdown"][number]["bucket"];
  netAmountMills: bigint;
};
type RevenueSummaryMills = {
  revenueMills: bigint;
  adjustmentMills: bigint;
  unclassifiedMills: bigint;
  netEarningsMills: bigint;
};

type PageSummary = Awaited<ReturnType<typeof findPageSummaryByLabel>>;
type PageSummaryRow = NonNullable<PageSummary>;

function serializeTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function serializeRawType(
  platform: "fansly" | "onlyfans",
  rawType: string,
) {
  if (platform === "fansly" && /^-?\d+$/.test(rawType)) {
    return Number.parseInt(rawType, 10);
  }

  return rawType;
}

function serializePage(row: {
  id: number;
  label: string;
  platform: "fansly" | "onlyfans";
  username: string | null;
  displayName: string | null;
  followerCount: number;
  subscriberCount: number;
  lastLightSyncAt: Date | null;
  lastFollowerSyncAt: Date | null;
  modelSlug: string;
  modelName: string;
}): AssignedPage {
  return {
    id: row.id,
    label: row.label,
    platform: row.platform,
    username: row.username,
    displayName: row.displayName,
    followerCount: row.followerCount,
    subscriberCount: row.subscriberCount,
    lastLightSyncAt: serializeTimestamp(row.lastLightSyncAt),
    lastFollowerSyncAt: serializeTimestamp(row.lastFollowerSyncAt),
    modelSlug: row.modelSlug,
    modelName: row.modelName,
  };
}

function serializeRevenueWindow(
  input: PeriodInput,
  bounds: PeriodBounds,
  rows: RevenueBreakdownRow[],
): RevenueWindowBase {
  const summary = summarizeRevenueRows(rows);
  return {
    period: input.period,
    from: bounds.from?.toISOString() ?? null,
    to: bounds.to?.toISOString() ?? null,
    currency: "USD" as const,
    ...serializeRevenueSummary(summary),
    breakdown: rows.map((row) => ({
      canonicalType: row.canonicalType,
      bucket: row.bucket,
      netAmountMills: millsToNumber(row.netAmountMills),
    })),
  };
}

function summarizeRevenueRows(rows: RevenueBreakdownRow[]): RevenueSummaryMills {
  const summary: RevenueSummaryMills = {
    revenueMills: 0n,
    adjustmentMills: 0n,
    unclassifiedMills: 0n,
    netEarningsMills: 0n,
  };

  for (const row of rows) {
    const netAmountMills = toMills(row.netAmountMills);

    if (row.bucket === "revenue") {
      summary.revenueMills += netAmountMills;
    } else if (row.bucket === "adjustment") {
      summary.adjustmentMills += netAmountMills;
    } else if (row.bucket === "unclassified") {
      summary.unclassifiedMills += netAmountMills;
    }
  }

  summary.netEarningsMills =
    summary.revenueMills + summary.adjustmentMills + summary.unclassifiedMills;

  return summary;
}

function serializeRevenueSummary(summary: RevenueSummaryMills) {
  const netEarningsMills = millsToNumber(summary.netEarningsMills);

  return {
    revenueMills: millsToNumber(summary.revenueMills),
    adjustmentMills: millsToNumber(summary.adjustmentMills),
    unclassifiedMills: millsToNumber(summary.unclassifiedMills),
    netEarningsMills,
    totalNetMills: netEarningsMills,
  };
}

function addComparison(
  base: RevenueWindowBase,
  currentNetEarnings: bigint,
  bounds: PeriodBounds | null,
  rows: RevenueBreakdownRow[],
): RevenueWindow {
  if (!bounds) {
    return {
      ...base,
      comparison: null,
    };
  }

  const previousSummary = summarizeRevenueRows(rows);
  const previousNetEarnings = previousSummary.netEarningsMills;
  const delta = currentNetEarnings - previousNetEarnings;

  return {
    ...base,
    comparison: {
      from: bounds.from!.toISOString(),
      to: bounds.to!.toISOString(),
      netEarningsMills: millsToNumber(previousNetEarnings),
      totalNetMills: millsToNumber(previousNetEarnings),
      deltaNetMills: millsToNumber(delta),
      deltaPct: previousNetEarnings === 0n
        ? null
        : (Number(delta) / Number(previousNetEarnings)) * 100,
    },
  };
}

function combinePeriodBounds(bounds: PeriodBounds[]): PeriodBounds {
  // Mixed-platform reports keep a single top-level window by taking the union
  // of each platform-local period.
  const withFrom = bounds
    .map((bounds) => bounds.from)
    .filter((value): value is Date => Boolean(value));
  const withTo = bounds
    .map((bounds) => bounds.to)
    .filter((value): value is Date => Boolean(value));

  return {
    from: withFrom.length > 0
      ? new Date(Math.min(...withFrom.map((value) => value.getTime())))
      : null,
    to: withTo.length > 0
      ? new Date(Math.max(...withTo.map((value) => value.getTime())))
      : null,
  };
}

function groupPageIdsByPlatform(
  pages: Array<Pick<PageSummaryRow, "id" | "platform">>,
) {
  const grouped = new Map<Platform, number[]>();

  for (const page of pages) {
    const current = grouped.get(page.platform) ?? [];
    current.push(page.id);
    grouped.set(page.platform, current);
  }

  return grouped;
}

function mergeRevenueBreakdownRows(rows: RevenueBreakdownRow[][]): RevenueBreakdownRow[] {
  const totals = new Map<RevenueBreakdownRow["canonicalType"], RevenueBreakdownRow>();

  for (const group of rows) {
    for (const row of group) {
      const existing = totals.get(row.canonicalType);
      if (!existing) {
        totals.set(row.canonicalType, { ...row });
        continue;
      }

      totals.set(row.canonicalType, {
        ...existing,
        netAmountMills: toMills(existing.netAmountMills) + toMills(row.netAmountMills),
      });
    }
  }

  return Array.from(totals.values())
    .sort((left, right) => left.canonicalType.localeCompare(right.canonicalType));
}

function mergePageRevenueTotals(rows: Awaited<ReturnType<typeof getRevenuePageTotals>>[]) {
  const totals = new Map<number, Awaited<ReturnType<typeof getRevenuePageTotals>>[number]>();

  for (const group of rows) {
    for (const row of group) {
      const existing = totals.get(row.pageId);
      if (!existing) {
        totals.set(row.pageId, row);
        continue;
      }

      totals.set(row.pageId, {
        ...row,
        netEarningsMills: toMills(existing.netEarningsMills) + toMills(row.netEarningsMills),
      });
    }
  }

  return Array.from(totals.values());
}

async function getRevenuePageTotalsByPlatform(
  app: AppContext,
  groupedPageIds: Map<Platform, number[]>,
  input: PeriodInput & { modelSlug?: string },
) {
  const now = input.now ?? new Date();
  const groups = Array.from(groupedPageIds.entries());

  return mergePageRevenueTotals(
    await Promise.all(groups.map(([platform, pageIds]) => getRevenuePageTotals(app.db, {
      pageIds,
      period: resolveRevenuePeriodBoundsForPlatform(platform, input.period, now, input.custom),
      modelSlug: input.modelSlug,
    }))),
  );
}

async function getRevenueBreakdownForGroups(
  app: AppContext,
  groupedPageIds: Map<Platform, number[]>,
  input: PeriodInput,
) {
  const now = input.now ?? new Date();
  const groups = Array.from(groupedPageIds.entries());
  const bounds = groups.map(([platform]) => (
    resolveRevenuePeriodBoundsForPlatform(platform, input.period, now, input.custom)
  ));

  return {
    bounds: combinePeriodBounds(bounds),
    rows: mergeRevenueBreakdownRows(
      await Promise.all(groups.map(([platform, pageIds]) => getRevenueBreakdownForScope(app.db, {
        pageIds,
        period: resolveRevenuePeriodBoundsForPlatform(platform, input.period, now, input.custom),
      }))),
    ),
  };
}

async function getRevenueComparisonForGroups(
  app: AppContext,
  groupedPageIds: Map<Platform, number[]>,
  input: PeriodInput,
) {
  const now = input.now ?? new Date();
  const groups = Array.from(groupedPageIds.entries());
  const bounds = groups.map(([platform]) => (
    resolveRevenueComparisonPeriodBoundsForPlatform(platform, input.period, now, input.custom)
  )).filter((value): value is PeriodBounds => value !== null);

  if (bounds.length === 0) {
    return {
      bounds: null,
      rows: [] as RevenueBreakdownRow[],
    };
  }

  return {
    bounds: combinePeriodBounds(bounds),
    rows: mergeRevenueBreakdownRows(
      await Promise.all(groups.map(async ([platform, pageIds]) => {
        const period = resolveRevenueComparisonPeriodBoundsForPlatform(
          platform,
          input.period,
          now,
          input.custom,
        );

        if (!period) {
          return [];
        }

        return getRevenueBreakdownForScope(app.db, {
          pageIds,
          period,
        });
      })),
    ),
  };
}

export async function getPageSummary(app: AppContext, pageLabel: string) {
  const page = await findPageSummaryByLabel(app.db, pageLabel);
  if (!page) {
    throw new NotFoundError(`Page "${pageLabel}" not found`);
  }

  return page;
}

export async function listPageSummaries(app: AppContext, pageIds?: number[]) {
  const rows = await listVisiblePages(app.db, pageIds);
  return rows.map((row) => serializePage(row));
}

export async function listModelSummaries(
  app: AppContext,
  pageIds?: number[],
): Promise<ModelListItem[]> {
  const rows = await listVisibleModels(app.db, pageIds);
  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    pageCount: row.pageCount,
  }));
}

export async function getPageRevenueReport(
  app: AppContext,
  pageLabel: string,
  input: PeriodInput,
): Promise<PageRevenueResponse> {
  const page = await getPageSummary(app, pageLabel);
  const now = input.now ?? new Date();
  const bounds = resolveRevenuePeriodBoundsForPlatform(
    page.platform,
    input.period,
    now,
    input.custom,
  );
  const currentRows = await getRevenueBreakdown(app.db, page.id, bounds.from, bounds.to);
  const currentTotal = summarizeRevenueRows(currentRows).netEarningsMills;
  const comparisonBounds = resolveRevenueComparisonPeriodBoundsForPlatform(
    page.platform,
    input.period,
    now,
    input.custom,
  );
  const comparisonRows = comparisonBounds
    ? await getRevenueBreakdown(app.db, page.id, comparisonBounds.from, comparisonBounds.to)
    : [];

  return {
    ...addComparison(
      serializeRevenueWindow(input, bounds, currentRows),
      currentTotal,
      comparisonBounds,
      comparisonRows,
    ),
    page: serializePage(page),
  };
}

export async function getOverviewRevenueReport(
  app: AppContext,
  input: PeriodInput & { pageIds?: number[] },
): Promise<OverviewRevenueResponse> {
  const pageRows = await listVisiblePages(app.db, input.pageIds);
  const modelRows = await listVisibleModels(app.db, input.pageIds);
  const groupedPageIds = groupPageIdsByPlatform(pageRows);
  const totals = await getRevenuePageTotalsByPlatform(app, groupedPageIds, input);
  const totalsByPageId = new Map(totals.map((row) => [row.pageId, row.netEarningsMills]));
  const current = await getRevenueBreakdownForGroups(app, groupedPageIds, input);
  const currentRows = current.rows;
  const currentTotal = summarizeRevenueRows(currentRows).netEarningsMills;
  const comparison = await getRevenueComparisonForGroups(app, groupedPageIds, input);

  const pages = pageRows.map((page) => ({
    pageId: page.id,
    pageLabel: page.label,
    modelSlug: page.modelSlug,
    modelName: page.modelName,
    netEarningsMills: millsToNumber(totalsByPageId.get(page.id) ?? 0n),
    totalNetMills: millsToNumber(totalsByPageId.get(page.id) ?? 0n),
  }));

  const totalsByModelSlug = new Map<string, bigint>();
  for (const page of pages) {
    totalsByModelSlug.set(
      page.modelSlug,
      (totalsByModelSlug.get(page.modelSlug) ?? 0n) + BigInt(page.netEarningsMills),
    );
  }

  return {
    ...addComparison(
      serializeRevenueWindow(input, current.bounds, currentRows),
      currentTotal,
      comparison.bounds,
      comparison.rows,
    ),
    models: modelRows.map((model) => ({
      modelId: model.id,
      modelSlug: model.slug,
      modelName: model.name,
      pageCount: model.pageCount,
      netEarningsMills: millsToNumber(totalsByModelSlug.get(model.slug) ?? 0n),
      totalNetMills: millsToNumber(totalsByModelSlug.get(model.slug) ?? 0n),
    })),
    pages,
  };
}

export async function getModelRevenueReport(
  app: AppContext,
  modelSlug: string,
  input: PeriodInput & { pageIds?: number[] },
): Promise<ModelRevenueResponse> {
  const model = await findVisibleModel(app.db, modelSlug, input.pageIds);
  if (!model) {
    throw new NotFoundError(`Model "${modelSlug}" not found`);
  }

  const pageRows = (await listVisiblePages(app.db, input.pageIds))
    .filter((page) => page.modelSlug === modelSlug);
  const groupedPageIds = groupPageIdsByPlatform(pageRows);
  const totals = await getRevenuePageTotalsByPlatform(app, groupedPageIds, {
    ...input,
    modelSlug,
  });
  const totalsByPageId = new Map(totals.map((row) => [row.pageId, row.netEarningsMills]));
  const current = await getRevenueBreakdownForGroups(app, groupedPageIds, input);
  const currentRows = current.rows;
  const currentTotal = summarizeRevenueRows(currentRows).netEarningsMills;
  const comparison = await getRevenueComparisonForGroups(app, groupedPageIds, input);

  return {
    ...addComparison(
      serializeRevenueWindow(input, current.bounds, currentRows),
      currentTotal,
      comparison.bounds,
      comparison.rows,
    ),
    model: {
      id: model.id,
      slug: model.slug,
      name: model.name,
      pageCount: model.pageCount,
    },
    pages: pageRows.map((page) => ({
      pageId: page.id,
      pageLabel: page.label,
      modelSlug: page.modelSlug,
      modelName: page.modelName,
      netEarningsMills: millsToNumber(totalsByPageId.get(page.id) ?? 0n),
      totalNetMills: millsToNumber(totalsByPageId.get(page.id) ?? 0n),
    })),
  };
}

export async function getPageTransactionsReport(
  app: AppContext,
  pageLabel: string,
  input: TransactionListQuery,
): Promise<TransactionListResponse> {
  const page = await getPageSummary(app, pageLabel);
  const rows = await listTransactionsForPage(app.db, {
    pageId: page.id,
    limit: input.limit,
    offset: input.offset,
    canonicalType: input.type,
    transactionState: input.state,
  });

  return {
    page: serializePage(page),
    items: rows.items.map((row) => ({
      transactionId: row.transactionId,
      rawType: serializeRawType(page.platform, row.rawType),
      canonicalType: row.canonicalType,
      transactionState: row.transactionState,
      amountMills: millsToNumber(row.amountMills),
      destinationAmountMills: millsToNumber(row.destinationAmountMills),
      netAmountMills: millsToNumber(row.netAmountMills),
      walletId: row.walletId,
      correlationId: row.correlationId,
      correlationAccountId: row.correlationAccountId,
      occurredAt: serializeTimestamp(row.occurredAt)!,
      sourceUpdatedAt: serializeTimestamp(row.sourceUpdatedAt),
      fan: row.fanPlatformUserId
        ? {
          platformUserId: row.fanPlatformUserId,
          username: row.fanUsername,
          displayName: row.fanDisplayName,
        }
        : null,
    })),
    limit: input.limit,
    offset: input.offset,
    total: rows.total,
  };
}

export async function getPageSubscribersReport(
  app: AppContext,
  pageLabel: string,
  input: Pick<TransactionListQuery, "limit" | "offset">,
): Promise<SubscriberListResponse> {
  const page = await getPageSummary(app, pageLabel);
  const rows = await listSubscribersForPage(app.db, {
    pageId: page.id,
    limit: input.limit,
    offset: input.offset,
  });

  return {
    page: serializePage(page),
    items: rows.items.map((row) => ({
      platformSubscriptionId: row.platformSubscriptionId,
      platformUserId: row.platformUserId,
      username: row.username,
      displayName: row.displayName,
      endsAt: serializeTimestamp(row.endsAt),
      autoRenew: row.autoRenew,
      subscriptionTierName: row.subscriptionTierName,
    })),
    limit: input.limit,
    offset: input.offset,
    total: rows.total,
  };
}

export async function getPageSubscribersDailyReport(
  app: AppContext,
  pageLabel: string,
  input: PeriodInput,
): Promise<SubscriberDailyResponse> {
  const page = await getPageSummary(app, pageLabel);
  const range = resolveBusinessDateRange(input.period, input.now ?? new Date(), input.custom);
  const items = await listSubscriberDailyForPage(app.db, {
    pageId: page.id,
    fromBusinessDate: range.from,
    toBusinessDate: range.toExclusive,
  });

  return {
    page: serializePage(page),
    items,
  };
}

export async function getPageFollowersReport(
  app: AppContext,
  pageLabel: string,
  input: Pick<TransactionListQuery, "limit" | "offset">,
): Promise<FollowerListResponse> {
  const page = await getPageSummary(app, pageLabel);
  const rows = await listFollowersForPage(app.db, {
    pageId: page.id,
    limit: input.limit,
    offset: input.offset,
  });

  return {
    page: serializePage(page),
    items: rows.items.map((row) => ({
      platformUserId: row.platformUserId,
      username: row.username,
      displayName: row.displayName,
      followedAt: serializeTimestamp(row.followedAt)!,
    })),
    limit: input.limit,
    offset: input.offset,
    total: rows.total,
  };
}

export async function getPageFollowersDailyReport(
  app: AppContext,
  pageLabel: string,
  input: PeriodInput,
): Promise<FollowerDailyResponse> {
  const page = await getPageSummary(app, pageLabel);
  const range = resolveBusinessDateRange(input.period, input.now ?? new Date(), input.custom);
  const items = await listFollowerDailyForPage(app.db, {
    pageId: page.id,
    fromBusinessDate: range.from,
    toBusinessDate: range.toExclusive,
  });

  return {
    page: serializePage(page),
    items,
  };
}

export async function getPageFansReport(
  app: AppContext,
  pageLabel: string,
  input: FanListQuery,
): Promise<FanListResponse> {
  const page = await getPageSummary(app, pageLabel);
  const rows = await listFansForPage(app.db, {
    pageId: page.id,
    limit: input.limit,
    offset: input.offset,
    query: input.query,
  });

  return {
    page: serializePage(page),
    items: rows.items.map((row) => ({
      platformUserId: row.platformUserId,
      username: row.username,
      displayName: row.displayName,
      totalCreatorNetMills: millsToNumber(row.totalCreatorNetMills),
      currency: "USD" as const,
      isFollower: row.isFollower,
      followerSince: serializeTimestamp(row.followerSince),
      isSubscriber: row.isSubscriber,
      subscriberSince: serializeTimestamp(row.subscriberSince),
      subscriptionExpiresAt: serializeTimestamp(row.subscriptionExpiresAt),
      autoRenew: row.autoRenew,
      lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
    })),
    limit: input.limit,
    offset: input.offset,
    total: rows.total,
  };
}

function buildMetadataLookup<T extends { platformAccountId: number }>(rows: T[]) {
  const byPage = new Map<number, T[]>();
  for (const row of rows) {
    const current = byPage.get(row.platformAccountId) ?? [];
    current.push(row);
    byPage.set(row.platformAccountId, current);
  }
  return byPage;
}

export async function getPageFanDetailReport(
  app: AppContext,
  pageLabel: string,
  platformUserId: string,
  pageIds?: number[],
): Promise<PageFanDetailResponse> {
  const page = await getPageSummary(app, pageLabel);
  const fan = await findFanOnPage(app.db, page.id, platformUserId);
  if (!fan) {
    throw new NotFoundError(`Fan "${platformUserId}" not found on page "${pageLabel}"`);
  }

  const [notes, summaries, flags, platformTotalSpendMills] = await Promise.all([
    listFanNotesForPages(app.db, fan.fanId, [page.id]),
    listFanSummariesForPages(app.db, fan.fanId, [page.id]),
    listFanFlags(app.db, fan.fanId),
    getPlatformTotalSpendForFan(app.db, {
      fanId: fan.fanId,
      platform: fan.platform,
      pageIds,
    }),
  ]);

  return {
    fan: {
      platform: fan.platform,
      platformUserId: fan.platformUserId,
      username: fan.username,
      displayName: fan.displayName,
      createdAtExternal: serializeTimestamp(fan.createdAtExternal),
    },
    platformTotalSpendMills: millsToNumber(platformTotalSpendMills),
    page: {
      pageId: fan.pageId,
      pageLabel: fan.pageLabel,
      modelSlug: fan.modelSlug,
      modelName: fan.modelName,
      totalCreatorNetMills: millsToNumber(fan.totalCreatorNetMills),
      currency: "USD" as const,
      isFollower: fan.isFollower,
      followerSince: serializeTimestamp(fan.followerSince),
      isSubscriber: fan.isSubscriber,
      subscriberSince: serializeTimestamp(fan.subscriberSince),
      subscriptionExpiresAt: serializeTimestamp(fan.subscriptionExpiresAt),
      autoRenew: fan.autoRenew,
      lastTransactionAt: serializeTimestamp(fan.lastTransactionAt),
      notes: notes.map((row) => ({
        id: row.id,
        authorUserId: row.authorUserId,
        body: row.body,
        createdAt: serializeTimestamp(row.createdAt)!,
      })),
      summaries: summaries.map((row) => ({
        id: row.id,
        authorUserId: row.authorUserId,
        body: row.body,
        createdAt: serializeTimestamp(row.createdAt)!,
      })),
    },
    flags: flags.map((row) => ({
      flag: row.flag,
      createdAt: serializeTimestamp(row.createdAt)!,
      createdByUserId: row.createdByUserId,
    })),
  };
}

export async function getCrossPageFanDetailReport(
  app: AppContext,
  input: {
    platform: "fansly" | "onlyfans";
    platformUserId: string;
    pageIds?: number[];
  },
): Promise<CrossPageFanDetailResponse> {
  const fan = await findPlatformFan(app.db, input.platform, input.platformUserId);
  if (!fan) {
    throw new NotFoundError(`Fan "${input.platformUserId}" not found`);
  }

  const pages = await listFanPageContexts(app.db, fan.id, input.pageIds);
  if (pages.length === 0) {
    throw new NotFoundError(`Fan "${input.platformUserId}" not found`);
  }

  const pageIds = pages.map((page) => page.pageId);
  const [notes, summaries, flags, platformTotalSpendMills] = await Promise.all([
    listFanNotesForPages(app.db, fan.id, pageIds),
    listFanSummariesForPages(app.db, fan.id, pageIds),
    listFanFlags(app.db, fan.id),
    getPlatformTotalSpendForFan(app.db, {
      fanId: fan.id,
      platform: fan.platform,
      pageIds: input.pageIds,
    }),
  ]);

  const notesByPage = buildMetadataLookup(notes);
  const summariesByPage = buildMetadataLookup(summaries);

  return {
    fan: {
      platform: fan.platform,
      platformUserId: fan.platformUserId,
      username: fan.username,
      displayName: fan.displayName,
      createdAtExternal: serializeTimestamp(fan.createdAtExternal),
    },
    platformTotalSpendMills: millsToNumber(platformTotalSpendMills),
    pages: pages.map((page) => ({
      pageId: page.pageId,
      pageLabel: page.pageLabel,
      modelSlug: page.modelSlug,
      modelName: page.modelName,
      totalCreatorNetMills: millsToNumber(page.totalCreatorNetMills),
      currency: "USD" as const,
      isFollower: page.isFollower,
      followerSince: serializeTimestamp(page.followerSince),
      isSubscriber: page.isSubscriber,
      subscriberSince: serializeTimestamp(page.subscriberSince),
      subscriptionExpiresAt: serializeTimestamp(page.subscriptionExpiresAt),
      autoRenew: page.autoRenew,
      lastTransactionAt: serializeTimestamp(page.lastTransactionAt),
      notes: (notesByPage.get(page.pageId) ?? []).map((row) => ({
        id: row.id,
        authorUserId: row.authorUserId,
        body: row.body,
        createdAt: serializeTimestamp(row.createdAt)!,
      })),
      summaries: (summariesByPage.get(page.pageId) ?? []).map((row) => ({
        id: row.id,
        authorUserId: row.authorUserId,
        body: row.body,
        createdAt: serializeTimestamp(row.createdAt)!,
      })),
    })),
    flags: flags.map((row) => ({
      flag: row.flag,
      createdAt: serializeTimestamp(row.createdAt)!,
      createdByUserId: row.createdByUserId,
    })),
  };
}

export async function getFanSpendSummary(
  app: AppContext,
  pageLabel: string,
  identifier: string,
) {
  const page = await getPageSummary(app, pageLabel);
  const result = await getFanSpendByIdentifier(app.db, page.id, identifier);
  return result.rows[0] ?? null;
}
