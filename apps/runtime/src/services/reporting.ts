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
  resolveComparisonPeriodBounds,
  resolvePeriodBounds,
  sumMills,
  type Period,
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
  total: bigint;
};

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
  bounds: ReturnType<typeof resolvePeriodBounds>,
  rows: RevenueBreakdownRow[],
): RevenueWindowBase {
  const totalNetMills = sumMills(rows.map((row) => row.total));
  return {
    period: input.period,
    from: bounds.from?.toISOString() ?? null,
    to: bounds.to?.toISOString() ?? null,
    currency: "USD" as const,
    totalNetMills: millsToNumber(totalNetMills),
    breakdown: rows.map((row) => ({
      canonicalType: row.canonicalType,
      netAmountMills: millsToNumber(row.total),
    })),
  };
}

function addComparison(
  base: RevenueWindowBase,
  currentTotal: bigint,
  bounds: ReturnType<typeof resolveComparisonPeriodBounds>,
  rows: RevenueBreakdownRow[],
): RevenueWindow {
  if (!bounds) {
    return {
      ...base,
      comparison: null,
    };
  }

  const previousTotal = sumMills(rows.map((row) => row.total));
  const delta = currentTotal - previousTotal;

  return {
    ...base,
    comparison: {
      from: bounds.from!.toISOString(),
      to: bounds.to!.toISOString(),
      totalNetMills: millsToNumber(previousTotal),
      deltaNetMills: millsToNumber(delta),
      deltaPct: previousTotal === 0n
        ? null
        : (Number(delta) / Number(previousTotal)) * 100,
    },
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
  const bounds = resolvePeriodBounds(input.period, input.now ?? new Date(), input.custom);
  const currentRows = await getRevenueBreakdown(app.db, page.id, bounds.from, bounds.to);
  const currentTotal = sumMills(currentRows.map((row) => row.total));
  const comparisonBounds = resolveComparisonPeriodBounds(
    input.period,
    input.now ?? new Date(),
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
  const bounds = resolvePeriodBounds(input.period, input.now ?? new Date(), input.custom);
  const pageRows = await listVisiblePages(app.db, input.pageIds);
  const modelRows = await listVisibleModels(app.db, input.pageIds);
  const totals = await getRevenuePageTotals(app.db, {
    pageIds: input.pageIds,
    period: bounds,
  });
  const totalsByPageId = new Map(totals.map((row) => [row.pageId, row.totalNetMills]));
  const currentRows = await getRevenueBreakdownForScope(app.db, {
    pageIds: input.pageIds,
    period: bounds,
  });
  const currentTotal = sumMills(currentRows.map((row) => row.total));
  const comparisonBounds = resolveComparisonPeriodBounds(
    input.period,
    input.now ?? new Date(),
    input.custom,
  );
  const comparisonRows = comparisonBounds
    ? await getRevenueBreakdownForScope(app.db, {
      pageIds: input.pageIds,
      period: comparisonBounds,
    })
    : [];

  const pages = pageRows.map((page) => ({
    pageId: page.id,
    pageLabel: page.label,
    modelSlug: page.modelSlug,
    modelName: page.modelName,
    totalNetMills: millsToNumber(totalsByPageId.get(page.id) ?? 0n),
  }));

  const totalsByModelSlug = new Map<string, bigint>();
  for (const page of pages) {
    totalsByModelSlug.set(
      page.modelSlug,
      (totalsByModelSlug.get(page.modelSlug) ?? 0n) + BigInt(page.totalNetMills),
    );
  }

  return {
    ...addComparison(
      serializeRevenueWindow(input, bounds, currentRows),
      currentTotal,
      comparisonBounds,
      comparisonRows,
    ),
    models: modelRows.map((model) => ({
      modelId: model.id,
      modelSlug: model.slug,
      modelName: model.name,
      pageCount: model.pageCount,
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

  const bounds = resolvePeriodBounds(input.period, input.now ?? new Date(), input.custom);
  const pageRows = (await listVisiblePages(app.db, input.pageIds))
    .filter((page) => page.modelSlug === modelSlug);
  const modelPageIds = pageRows.map((page) => page.id);
  const totals = await getRevenuePageTotals(app.db, {
    pageIds: modelPageIds,
    period: bounds,
    modelSlug,
  });
  const totalsByPageId = new Map(totals.map((row) => [row.pageId, row.totalNetMills]));
  const currentRows = await getRevenueBreakdownForScope(app.db, {
    pageIds: modelPageIds,
    period: bounds,
  });
  const currentTotal = sumMills(currentRows.map((row) => row.total));
  const comparisonBounds = resolveComparisonPeriodBounds(
    input.period,
    input.now ?? new Date(),
    input.custom,
  );
  const comparisonRows = comparisonBounds
    ? await getRevenueBreakdownForScope(app.db, {
      pageIds: modelPageIds,
      period: comparisonBounds,
    })
    : [];

  return {
    ...addComparison(
      serializeRevenueWindow(input, bounds, currentRows),
      currentTotal,
      comparisonBounds,
      comparisonRows,
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
    getPlatformTotalSpendForFan(app.db, fan.fanId),
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
    getPlatformTotalSpendForFan(app.db, fan.id),
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
