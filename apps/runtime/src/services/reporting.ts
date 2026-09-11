import type {
  AssignedPage,
  CrossPageFanDetailResponse,
  FanListQuery,
  FanListResponse,
  FollowerDailyResponse,
  FollowerListQuery,
  FollowerListResponse,
  ModelListItem,
  ModelRevenueResponse,
  OverviewGrowthResponse,
  OverviewRevenueResponse,
  PageDeletedFansResponse,
  PageFanDetailResponse,
  PageRevenueResponse,
  PlatformRevenueWindow,
  SubscriberDailyResponse,
  SubscriberListQuery,
  SubscriberListResponse,
  TransactionListQuery,
  TransactionListResponse,
} from "@agency_hub_core/contracts";
import {
  findFanOnPage,
  findPageSummaryByLabel,
  findPlatformFan,
  findRevenueModel,
  getFanSpendByIdentifier,
  getPlatformTotalSpendForFan,
  getRevenueBreakdown,
  getRevenueBreakdownForScope,
  getRevenuePageTotals,
  listFansForPage,
  listFollowerDailyForPage,
  listFollowersForPage,
  listFollowerTotalsForPages,
  listFanPageContexts,
  listDeletedFansForPage,
  listSubscribersForPage,
  listSubscriberDailyForPage,
  listSubscriberTotalsForPages,
  listTransactionsForPage,
  listRevenueModels,
  listRevenuePages,
  listVisibleModels,
  listVisiblePages,
  listFanFlags,
  listFanNotesForPages,
  listFanSummariesForPages,
} from "@agency_hub_core/db";
import {
  millsToNumber,
  resolveBusinessDateRangeForPlatform,
  resolveRevenueComparisonPeriodBoundsForPlatform,
  resolveRevenuePeriodBoundsForPlatform,
  millsFromInteger,
  type PeriodBounds,
  type Period,
  type Platform,
} from "@agency_hub_core/shared";

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

function serializePageMetric(value: number | null | undefined) {
  return {
    value: value ?? null,
    available: value !== null && value !== undefined,
  };
}

function millsToRoundedCents(value: bigint | number | string | null | undefined) {
  if (value == null) {
    return 0;
  }

  const mills = millsFromInteger(value);
  return Number((mills + (mills >= 0n ? 5n : -5n)) / 10n);
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
  followerCount: number | null;
  subscriberCount: number | null;
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
    followerCount: serializePageMetric(row.followerCount),
    subscriberCount: serializePageMetric(row.subscriberCount),
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
  platformWindows: PlatformRevenueWindow[],
): RevenueWindowBase {
  const summary = summarizeRevenueRows(rows);
  return {
    period: input.period,
    windowAt: input.now!.toISOString(),
    from: bounds.from?.toISOString() ?? null,
    to: bounds.to?.toISOString() ?? null,
    platformWindows,
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
    const netAmountMills = millsFromInteger(row.netAmountMills);

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

function revenueDelta(current: bigint, previous: bigint | null) {
  if (previous === null) return { deltaNetMills: null, deltaPct: null };
  const delta = current - previous;
  return {
    deltaNetMills: millsToNumber(delta),
    deltaPct: previous === 0n ? null : Number(delta) / Number(previous < 0n ? -previous : previous) * 100,
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
  const currentSources = new Map(base.breakdown.map((row) => [row.canonicalType, row]));
  const previousSources = new Map(rows.map((row) => [row.canonicalType, row]));
  const types = [...new Set([...currentSources.keys(), ...previousSources.keys()])].sort();

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
        : (Number(delta) / Number(previousNetEarnings < 0n ? -previousNetEarnings : previousNetEarnings)) * 100,
      sources: types.map((canonicalType) => {
        const current = currentSources.get(canonicalType);
        const previous = previousSources.get(canonicalType);
        const currentNet = millsFromInteger(current?.netAmountMills ?? 0);
        const previousNet = millsFromInteger(previous?.netAmountMills ?? 0);
        return {
          canonicalType,
          bucket: (current ?? previous)!.bucket,
          currentNetMills: millsToNumber(currentNet),
          previousNetMills: millsToNumber(previousNet),
          ...revenueDelta(currentNet, previousNet),
          deltaNetMills: millsToNumber(currentNet - previousNet),
        };
      }),
    },
  };
}

// Audit B2: OnlyFans trailing windows are deliberately one calendar day longer
// than other platforms', so a mixed-platform total under one top-level window
// silently spans different widths. Every revenue report now discloses the
// exact window (and comparison window) each platform contributed.
function buildPlatformRevenueWindows(
  platforms: Platform[],
  input: PeriodInput,
  now: Date,
): PlatformRevenueWindow[] {
  return [...platforms].sort().map((platform) => {
    const bounds = resolveRevenuePeriodBoundsForPlatform(platform, input.period, now, input.custom);
    const comparison = resolveRevenueComparisonPeriodBoundsForPlatform(
      platform,
      input.period,
      now,
      input.custom,
    );

    return {
      platform,
      from: bounds.from?.toISOString() ?? null,
      to: bounds.to?.toISOString() ?? null,
      comparisonFrom: comparison?.from?.toISOString() ?? null,
      comparisonTo: comparison?.to?.toISOString() ?? null,
    };
  });
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
        netAmountMills: millsFromInteger(existing.netAmountMills) + millsFromInteger(row.netAmountMills),
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
        netEarningsMills: millsFromInteger(existing.netEarningsMills) + millsFromInteger(row.netEarningsMills),
      });
    }
  }

  return Array.from(totals.values());
}

async function getRevenuePageTotalsByPlatform(
  app: AppContext,
  groupedPageIds: Map<Platform, number[]>,
  input: PeriodInput & { modelSlug?: string; comparison?: boolean },
) {
  const now = input.now ?? new Date();
  const groups = Array.from(groupedPageIds.entries());

  return mergePageRevenueTotals(
    await Promise.all(groups.map(([platform, pageIds]) => {
      const period = input.comparison
        ? resolveRevenueComparisonPeriodBoundsForPlatform(platform, input.period, now, input.custom)
        : resolveRevenuePeriodBoundsForPlatform(platform, input.period, now, input.custom);
      return period ? getRevenuePageTotals(app.db, {
        platform,
        pageIds,
        period,
        modelSlug: input.modelSlug,
      }) : Promise.resolve([]);
    })),
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
        platform,
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
          platform,
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
  input = { ...input, now: input.now ?? new Date() };
  const page = await getPageSummary(app, pageLabel);
  const now = input.now ?? new Date();
  const bounds = resolveRevenuePeriodBoundsForPlatform(
    page.platform,
    input.period,
    now,
    input.custom,
  );
  const currentRows = await getRevenueBreakdown(
    app.db,
    page.id,
    page.platform,
    bounds.from,
    bounds.to,
  );
  const currentTotal = summarizeRevenueRows(currentRows).netEarningsMills;
  const comparisonBounds = resolveRevenueComparisonPeriodBoundsForPlatform(
    page.platform,
    input.period,
    now,
    input.custom,
  );
  const comparisonRows = comparisonBounds
    ? await getRevenueBreakdown(
      app.db,
      page.id,
      page.platform,
      comparisonBounds.from,
      comparisonBounds.to,
    )
    : [];

  return {
    ...addComparison(
      serializeRevenueWindow(
        input,
        bounds,
        currentRows,
        buildPlatformRevenueWindows([page.platform], input, now),
      ),
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
  // Pin one clock across current/previous totals and disclosed boundaries.
  input = { ...input, now: input.now ?? new Date() };
  // W7.2 (A33, decision #131): revenue attribution reads ALL pages —
  // tombstoned pages keep their history in the rollups.
  const pageRows = await listRevenuePages(app.db, input.pageIds);
  const modelRows = await listRevenueModels(app.db, input.pageIds);
  const groupedPageIds = groupPageIdsByPlatform(pageRows);
  const [totals, previousTotals] = await Promise.all([
    getRevenuePageTotalsByPlatform(app, groupedPageIds, input),
    getRevenuePageTotalsByPlatform(app, groupedPageIds, { ...input, comparison: true }),
  ]);
  const totalsByPageId = new Map(totals.map((row) => [row.pageId, row.netEarningsMills]));
  const previousByPageId = new Map(previousTotals.map((row) => [row.pageId, row.netEarningsMills]));
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
    previousNetEarningsMills: comparison.bounds
      ? millsToNumber(previousByPageId.get(page.id) ?? 0n)
      : null,
    ...revenueDelta(totalsByPageId.get(page.id) ?? 0n, comparison.bounds ? previousByPageId.get(page.id) ?? 0n : null),
    platform: page.platform,
    status: page.status as "active" | "deleted",
  }));

  const totalsByModelSlug = new Map<string, bigint>();
  const previousByModelSlug = new Map<string, bigint>();
  for (const page of pages) {
    totalsByModelSlug.set(
      page.modelSlug,
      (totalsByModelSlug.get(page.modelSlug) ?? 0n) + BigInt(page.netEarningsMills),
    );
    previousByModelSlug.set(
      page.modelSlug,
      (previousByModelSlug.get(page.modelSlug) ?? 0n) + millsFromInteger(page.previousNetEarningsMills ?? 0),
    );
  }

  return {
    ...addComparison(
      serializeRevenueWindow(
        input,
        current.bounds,
        currentRows,
        buildPlatformRevenueWindows(
          Array.from(groupedPageIds.keys()),
          input,
          input.now ?? new Date(),
        ),
      ),
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
      previousNetEarningsMills: comparison.bounds
        ? millsToNumber(previousByModelSlug.get(model.slug) ?? 0n)
        : null,
      ...revenueDelta(totalsByModelSlug.get(model.slug) ?? 0n, comparison.bounds ? previousByModelSlug.get(model.slug) ?? 0n : null),
      status: (model.activePageCount > 0 ? "active" : "retired") as "active" | "retired",
    })),
    pages,
  };
}

export async function getModelRevenueReport(
  app: AppContext,
  modelSlug: string,
  input: PeriodInput & { pageIds?: number[] },
): Promise<ModelRevenueResponse> {
  input = { ...input, now: input.now ?? new Date() };
  // W7.2 (A33): the model report is a historical rollup — reachable and
  // complete even when some (or all) of its pages are tombstoned.
  const model = await findRevenueModel(app.db, modelSlug, input.pageIds);
  if (!model) {
    throw new NotFoundError(`Model "${modelSlug}" not found`);
  }

  const pageRows = (await listRevenuePages(app.db, input.pageIds))
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
      serializeRevenueWindow(
        input,
        current.bounds,
        currentRows,
        buildPlatformRevenueWindows(
          Array.from(groupedPageIds.keys()),
          input,
          input.now ?? new Date(),
        ),
      ),
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
      status: page.status as "active" | "deleted",
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
          pageAlias: row.fanPageAlias,
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
  input: SubscriberListQuery,
): Promise<SubscriberListResponse> {
  const page = await getPageSummary(app, pageLabel);
  const rows = await listSubscribersForPage(app.db, {
    pageId: page.id,
    limit: input.limit,
    offset: input.offset,
    query: input.query,
    expiringWithinDays: input.expiringWithinDays,
    startedWithinHours: input.startedWithinHours,
    autoRenew: input.autoRenew,
  });

  return {
    page: serializePage(page),
    items: rows.items.map((row) => ({
      platformSubscriptionId: row.platformSubscriptionId,
      platformUserId: row.platformUserId,
      pageAlias: row.pageAlias,
      username: row.username,
      displayName: row.displayName,
      endsAt: serializeTimestamp(row.endsAt),
      autoRenew: row.autoRenew,
      autoRenewOffDetectedAt: serializeTimestamp(row.autoRenewOffDetectedAt),
      subscriptionTierName: row.subscriptionTierName,
      startedAt: serializeTimestamp(row.sourceCreatedAt),
      totalSpentCents: millsToRoundedCents(row.totalCreatorNetAmountMills),
      lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
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
  const range = resolveBusinessDateRangeForPlatform(
    page.platform,
    input.period,
    input.now ?? new Date(),
    input.custom,
  );
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
  input: FollowerListQuery,
): Promise<FollowerListResponse> {
  const page = await getPageSummary(app, pageLabel);
  const rows = await listFollowersForPage(app.db, {
    pageId: page.id,
    limit: input.limit,
    offset: input.offset,
    query: input.query,
    followedWithinHours: input.followedWithinHours,
    subscriber: input.subscriber,
    dmStatus: input.dmStatus,
    activeWithinMinutes: input.activeWithinMinutes,
  });

  return {
    page: serializePage(page),
    items: rows.items.map((row) => ({
      platformUserId: row.platformUserId,
      pageAlias: row.pageAlias,
      username: row.username,
      displayName: row.displayName,
      followedAt: serializeTimestamp(row.followedAt)!,
      isSubscriber: row.isSubscriber,
      subscriberSince: serializeTimestamp(row.subscriberSince),
      subscriptionExpiresAt: serializeTimestamp(row.subscriptionExpiresAt),
      autoRenew: row.autoRenew,
      autoRenewOffDetectedAt: serializeTimestamp(row.autoRenewOffDetectedAt),
      totalSpentCents: millsToRoundedCents(row.totalCreatorNetAmountMills),
      lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
      dm: {
        hasConversation: row.platformConversationId !== null,
        platformConversationId: row.platformConversationId,
        unreadCount: row.unreadCount ?? 0,
        lastMessageAt: serializeTimestamp(row.lastMessageAt),
        lastFanMessageAt: serializeTimestamp(row.lastFanMessageAt),
        lastModelMessageAt: serializeTimestamp(row.lastModelMessageAt),
        lastMessagePreview: row.lastMessagePreview,
      },
      presence: {
        status: row.presenceStatus,
        lastSeenAt: serializeTimestamp(row.externalPresenceAt),
        observedAt: serializeTimestamp(row.externalPresenceObservedAt),
      },
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
  const range = resolveBusinessDateRangeForPlatform(
    page.platform,
    input.period,
    input.now ?? new Date(),
    input.custom,
  );
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
      pageAlias: row.pageAlias,
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
      autoRenewOffDetectedAt: serializeTimestamp(row.autoRenewOffDetectedAt),
      lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
    })),
    limit: input.limit,
    offset: input.offset,
    total: rows.total,
  };
}

export async function getPageDeletedFansReport(
  app: AppContext,
  pageLabel: string,
  input: FanListQuery,
): Promise<PageDeletedFansResponse> {
  const page = await getPageSummary(app, pageLabel);
  const rows = await listDeletedFansForPage(app.db, {
    pageId: page.id,
    limit: input.limit,
    offset: input.offset,
  });

  return {
    page: serializePage(page),
    items: rows.items.map((row) => ({
      platformUserId: row.platformUserId,
      latestKnownLabel: row.latestHistoricalPageAlias ??
        row.latestHistoricalUsername ??
        row.pageAlias ??
        row.displayName ??
        row.username,
      pageAlias: row.pageAlias,
      username: row.username,
      displayName: row.displayName,
      latestHistoricalPageAlias: row.latestHistoricalPageAlias,
      latestHistoricalUsername: row.latestHistoricalUsername,
      deletedDetectedAt: serializeTimestamp(row.deletedDetectedAt)!,
      deletedLastDetectedAt: serializeTimestamp(row.deletedLastDetectedAt),
      lastSeenAt: serializeTimestamp(row.lastSeenAt)!,
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
      pageAlias: fan.pageAlias,
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
      autoRenewOffDetectedAt: serializeTimestamp(fan.autoRenewOffDetectedAt),
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
      autoRenewOffDetectedAt: serializeTimestamp(page.autoRenewOffDetectedAt),
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

export async function getOverviewGrowthReport(
  app: AppContext,
  input: PeriodInput & { pageIds?: number[] },
): Promise<OverviewGrowthResponse> {
  const pageRows = await listVisiblePages(app.db, input.pageIds);
  const groupedPageIds = groupPageIdsByPlatform(pageRows);
  const now = input.now ?? new Date();

  const followerMap = new Map<number, number>();
  const subscriberMap = new Map<number, number>();

  for (const [platform, pageIds] of groupedPageIds) {
    const range = resolveBusinessDateRangeForPlatform(platform, input.period, now, input.custom);
    const [followers, subscribers] = await Promise.all([
      listFollowerTotalsForPages(app.db, {
        pageIds,
        fromBusinessDate: range.from,
        toBusinessDate: range.toExclusive,
      }),
      listSubscriberTotalsForPages(app.db, {
        pageIds,
        fromBusinessDate: range.from,
        toBusinessDate: range.toExclusive,
      }),
    ]);

    for (const row of followers) {
      followerMap.set(row.pageId, (followerMap.get(row.pageId) ?? 0) + row.newFollowers);
    }
    for (const row of subscribers) {
      subscriberMap.set(row.pageId, (subscriberMap.get(row.pageId) ?? 0) + row.newSubscribers);
    }
  }

  return {
    pages: pageRows.map((page) => ({
      pageId: page.id,
      newFollowers: followerMap.get(page.id) ?? 0,
      newSubscribers: subscriberMap.get(page.id) ?? 0,
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
