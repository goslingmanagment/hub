import type {
  FansSearchQuery,
  FansSearchResponse,
  SpenderBatchBody,
  SpenderBatchResponse,
  SpenderDetailQuery,
  SpenderDetailResponse,
  SpenderListQuery,
  SpenderListResponse,
  SpenderSeriesQuery,
  SpenderSeriesResponse,
} from "@fansly-connect/contracts";
import {
  findPageSummaryByLabel,
  findVisibleFanByIdentity,
  findVisibleFansByPlatformUserIds,
  getEarliestSpenderBusinessDateForFan,
  getScopedLifetimeTotalsForFan,
  getSpenderDailySeriesRows,
  getSpenderLifetimeMetrics,
  getSpenderProjectionAsOf,
  getSpenderRevenueDiagnosticsForScope,
  getSpenderWindowMetrics,
  getVisibleFanPageMemberships,
  listRankedSpenders,
  listVisibleScopePages,
  searchFansInScope,
  type RankedSpenderRow,
  type SpenderSortBy,
  type SpenderWindowMetricRow,
} from "@fansly-connect/db";
import {
  millsToNumber,
  nextBusinessDate,
  parseBusinessDate,
  previousBusinessDate,
  resolveAutoSpenderSeriesGranularity,
  resolveBusinessTimeZone,
  resolveSpenderBusinessDateRangeForPlatform,
  resolveSpenderComparisonPeriodBoundsForPlatform,
  toBusinessDate,
  type Platform,
  type SpenderPeriod,
} from "@fansly-connect/shared";

import type { AppContext } from "../bootstrap.ts";
import { canAccessPage, type AuthPrincipal } from "./auth.ts";
import { BadRequestError, ForbiddenError, NotFoundError } from "./errors.ts";

type ScopeFields = {
  scope: "page" | "model" | "agency";
  pageLabel?: string;
  modelSlug?: string;
  platform?: Platform;
};

type PeriodFields = {
  period?: SpenderPeriod;
  from?: string;
  to?: string;
};

type ResolvedScope = {
  platform: Platform;
  pageIds: number[];
  visiblePlatformPageIds: number[];
  responseScope: SpenderListResponse["scope"];
};

type WindowMetricLike = {
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  postedGrossAmountMills: bigint;
  pendingGrossAmountMills: bigint;
  unknownGrossAmountMills: bigint;
  postedCreatorNetAmountMills: bigint;
  pendingCreatorNetAmountMills: bigint;
  unknownCreatorNetAmountMills: bigint;
  transactionCount: number;
  lastTransactionAt: Date | null;
};

type LifetimeMetricLike = {
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
};

type SerializedWindowMetrics = NonNullable<SpenderListResponse["items"][number]["metrics"]["window"]>;

type FanLike = {
  platform: Platform;
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  createdAtExternal: Date | null;
};

function visiblePageIdsForPrincipal(principal: AuthPrincipal) {
  return principal.user.role === "owner" ? undefined : principal.assignedPageIds;
}

function serializeTimestamp(value: Date | string | null | undefined) {
  if (!value) {
    return null;
  }

  return new Date(value).toISOString();
}

function serializeFan(input: FanLike) {
  return {
    platform: input.platform,
    platformUserId: input.platformUserId,
    username: input.username,
    displayName: input.displayName,
    createdAtExternal: serializeTimestamp(input.createdAtExternal),
  };
}

function normalizePeriodInput(input: PeriodFields) {
  const period = input.period ?? "lifetime";
  return {
    period,
    custom: period === "custom" && input.from && input.to
      ? { from: input.from, to: input.to }
      : undefined,
  };
}

function zeroWindowMetrics(): SerializedWindowMetrics {
  return {
    grossAmountMills: 0,
    creatorNetAmountMills: 0,
    postedGrossAmountMills: 0,
    pendingGrossAmountMills: 0,
    unknownGrossAmountMills: 0,
    postedCreatorNetAmountMills: 0,
    pendingCreatorNetAmountMills: 0,
    unknownCreatorNetAmountMills: 0,
    transactionCount: 0,
    lastTransactionAt: null,
  };
}

function serializeWindowMetrics(
  metrics?: WindowMetricLike | null,
): SerializedWindowMetrics {
  if (!metrics) {
    return zeroWindowMetrics();
  }

  return {
    grossAmountMills: millsToNumber(metrics.grossAmountMills),
    creatorNetAmountMills: millsToNumber(metrics.creatorNetAmountMills),
    postedGrossAmountMills: millsToNumber(metrics.postedGrossAmountMills),
    pendingGrossAmountMills: millsToNumber(metrics.pendingGrossAmountMills),
    unknownGrossAmountMills: millsToNumber(metrics.unknownGrossAmountMills),
    postedCreatorNetAmountMills: millsToNumber(metrics.postedCreatorNetAmountMills),
    pendingCreatorNetAmountMills: millsToNumber(metrics.pendingCreatorNetAmountMills),
    unknownCreatorNetAmountMills: millsToNumber(metrics.unknownCreatorNetAmountMills),
    transactionCount: metrics.transactionCount,
    lastTransactionAt: serializeTimestamp(metrics.lastTransactionAt),
  };
}

function serializeLifetimeMetrics(
  scopeMetrics?: LifetimeMetricLike | null,
  platformMetrics?: LifetimeMetricLike | null,
): SpenderListResponse["items"][number]["metrics"]["lifetime"] {
  return {
    scopeGrossAmountMills: millsToNumber(scopeMetrics?.grossAmountMills ?? 0n),
    scopeCreatorNetAmountMills: millsToNumber(scopeMetrics?.creatorNetAmountMills ?? 0n),
    platformGrossAmountMills: millsToNumber(platformMetrics?.grossAmountMills ?? 0n),
    platformCreatorNetAmountMills: millsToNumber(platformMetrics?.creatorNetAmountMills ?? 0n),
  };
}

function serializeComparison(
  currentMetrics?: WindowMetricLike | null,
  previousMetrics?: WindowMetricLike | null,
): SpenderListResponse["items"][number]["metrics"]["comparison"] {
  if (!currentMetrics || !previousMetrics) {
    return null;
  }

  const deltaGrossAmountMills = currentMetrics.grossAmountMills - previousMetrics.grossAmountMills;
  const deltaCreatorNetAmountMills =
    currentMetrics.creatorNetAmountMills - previousMetrics.creatorNetAmountMills;

  return {
    previousGrossAmountMills: millsToNumber(previousMetrics.grossAmountMills),
    previousCreatorNetAmountMills: millsToNumber(previousMetrics.creatorNetAmountMills),
    deltaGrossAmountMills: millsToNumber(deltaGrossAmountMills),
    deltaCreatorNetAmountMills: millsToNumber(deltaCreatorNetAmountMills),
    deltaPct: previousMetrics.grossAmountMills === 0n
      ? null
      : (Number(deltaGrossAmountMills) / Number(previousMetrics.grossAmountMills)) * 100,
  };
}

function toPeriodMetadata(
  platform: Platform,
  period: SpenderPeriod,
  custom: { from: string; to: string } | undefined,
  asOf: Date | null,
) {
  const resolved = resolveSpenderBusinessDateRangeForPlatform(
    platform,
    period,
    new Date(),
    custom,
  );

  return {
    timeZone: resolved.timeZone,
    fromBusinessDate: resolved.fromBusinessDate,
    toBusinessDateInclusive: resolved.toBusinessDateInclusive,
    asOf: serializeTimestamp(asOf),
  };
}

function resolveComparisonRange(
  platform: Platform,
  period: SpenderPeriod,
  custom: { from: string; to: string } | undefined,
) {
  const timeZone = resolveBusinessTimeZone(platform);
  const bounds = resolveSpenderComparisonPeriodBoundsForPlatform(
    platform,
    period,
    new Date(),
    custom,
  );

  if (!bounds?.from || !bounds.to) {
    return null;
  }

  return {
    fromBusinessDate: toBusinessDate(bounds.from, timeZone),
    toBusinessDateExclusive: toBusinessDate(bounds.to, timeZone),
  };
}

async function resolveSpenderScope(
  app: AppContext,
  principal: AuthPrincipal,
  input: ScopeFields,
) {
  const scopedPageIds = visiblePageIdsForPrincipal(principal);

  if (principal.authMethod === "api_key" && input.scope !== "page") {
    throw new ForbiddenError("API key spender routes require page scope");
  }

  if (input.scope === "page") {
    const page = await findPageSummaryByLabel(app.db, input.pageLabel!);
    if (!page) {
      throw new NotFoundError(`Page "${input.pageLabel}" not found`);
    }
    if (!canAccessPage(principal, page.id)) {
      throw new ForbiddenError("Page access denied");
    }

    const visiblePlatformPages = await listVisibleScopePages(app.db, {
      platform: page.platform,
      pageIds: scopedPageIds,
    });

    return {
      platform: page.platform,
      pageIds: [page.id],
      visiblePlatformPageIds: visiblePlatformPages.map((row) => row.id),
      responseScope: {
        kind: "page" as const,
        platform: page.platform,
        pageCount: 1,
        page: {
          id: page.id,
          label: page.label,
          platform: page.platform,
          modelSlug: page.modelSlug,
          modelName: page.modelName,
        },
        model: null,
      },
    } satisfies ResolvedScope;
  }

  if (input.scope === "model") {
    const platform = input.platform!;
    const pages = await listVisibleScopePages(app.db, {
      platform,
      pageIds: scopedPageIds,
      modelSlug: input.modelSlug,
    });

    if (pages.length === 0) {
      throw new NotFoundError(
        `Model "${input.modelSlug}" has no visible ${platform} pages`,
      );
    }

    const visiblePlatformPages = await listVisibleScopePages(app.db, {
      platform,
      pageIds: scopedPageIds,
    });

    return {
      platform,
      pageIds: pages.map((row) => row.id),
      visiblePlatformPageIds: visiblePlatformPages.map((row) => row.id),
      responseScope: {
        kind: "model" as const,
        platform,
        pageCount: pages.length,
        page: null,
        model: {
          slug: pages[0]!.modelSlug,
          name: pages[0]!.modelName,
        },
      },
    } satisfies ResolvedScope;
  }

  const platform = input.platform!;
  const visiblePlatformPages = await listVisibleScopePages(app.db, {
    platform,
    pageIds: scopedPageIds,
  });

  return {
    platform,
    pageIds: visiblePlatformPages.map((row) => row.id),
    visiblePlatformPageIds: visiblePlatformPages.map((row) => row.id),
    responseScope: {
      kind: "agency" as const,
      platform,
      pageCount: visiblePlatformPages.length,
      page: null,
      model: null,
    },
  } satisfies ResolvedScope;
}

async function resolveAsOf(app: AppContext, scope: ResolvedScope) {
  return getSpenderProjectionAsOf(app.db, {
    pageIds: scope.pageIds,
    platform: scope.platform,
  });
}

function normalizeSortBy(
  period: SpenderPeriod,
  sortBy: SpenderSortBy | undefined,
  sortDir: "asc" | "desc" | undefined,
) {
  return {
    sortBy: sortBy ?? (period === "lifetime" ? "lifetimeGrossAmountMills" : "grossAmountMills"),
    sortDir: sortDir ?? "desc",
  } as const;
}

function bucketStartForWeek(value: string) {
  const date = new Date(Date.UTC(
    parseBusinessDate(value).year,
    parseBusinessDate(value).month - 1,
    parseBusinessDate(value).day,
  ));
  const day = date.getUTCDay();
  const distanceFromMonday = (day + 6) % 7;
  date.setUTCDate(date.getUTCDate() - distanceFromMonday);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function bucketEndForWeek(value: string) {
  let current = bucketStartForWeek(value);
  for (let index = 0; index < 6; index += 1) {
    current = nextBusinessDate(current);
  }
  return current;
}

function bucketStartForMonth(value: string) {
  const { year, month } = parseBusinessDate(value);
  return `${year}-${String(month).padStart(2, "0")}-01`;
}

function bucketEndForMonth(value: string) {
  const { year, month } = parseBusinessDate(value);
  const nextMonth = month === 12
    ? { year: year + 1, month: 1 }
    : { year, month: month + 1 };
  return previousBusinessDate(`${nextMonth.year}-${String(nextMonth.month).padStart(2, "0")}-01`);
}

function maxBusinessDate(left: string, right: string) {
  return left > right ? left : right;
}

function minBusinessDate(left: string, right: string) {
  return left < right ? left : right;
}

function buildSeriesBuckets(
  fromBusinessDate: string,
  toBusinessDateInclusive: string,
  granularity: "day" | "week" | "month",
) {
  const buckets: Array<{ fromBusinessDate: string; toBusinessDateInclusive: string }> = [];
  let cursor = fromBusinessDate;

  while (cursor <= toBusinessDateInclusive) {
    if (granularity === "day") {
      buckets.push({
        fromBusinessDate: cursor,
        toBusinessDateInclusive: cursor,
      });
      cursor = nextBusinessDate(cursor);
      continue;
    }

    if (granularity === "week") {
      const start = maxBusinessDate(bucketStartForWeek(cursor), fromBusinessDate);
      const end = minBusinessDate(bucketEndForWeek(cursor), toBusinessDateInclusive);
      buckets.push({
        fromBusinessDate: start,
        toBusinessDateInclusive: end,
      });
      cursor = nextBusinessDate(end);
      continue;
    }

    const start = maxBusinessDate(bucketStartForMonth(cursor), fromBusinessDate);
    const end = minBusinessDate(bucketEndForMonth(cursor), toBusinessDateInclusive);
    buckets.push({
      fromBusinessDate: start,
      toBusinessDateInclusive: end,
    });
    cursor = nextBusinessDate(end);
  }

  return buckets;
}

function aggregateSeriesBucket(
  rowsByBusinessDate: Map<string, WindowMetricLike>,
  bucket: { fromBusinessDate: string; toBusinessDateInclusive: string },
) {
  let cursor = bucket.fromBusinessDate;
  let grossAmountMills = 0n;
  let creatorNetAmountMills = 0n;
  let postedGrossAmountMills = 0n;
  let pendingGrossAmountMills = 0n;
  let unknownGrossAmountMills = 0n;
  let postedCreatorNetAmountMills = 0n;
  let pendingCreatorNetAmountMills = 0n;
  let unknownCreatorNetAmountMills = 0n;
  let transactionCount = 0;
  let lastTransactionAt: Date | null = null;

  while (cursor <= bucket.toBusinessDateInclusive) {
    const row = rowsByBusinessDate.get(cursor);
    if (row) {
      grossAmountMills += row.grossAmountMills;
      creatorNetAmountMills += row.creatorNetAmountMills;
      postedGrossAmountMills += row.postedGrossAmountMills;
      pendingGrossAmountMills += row.pendingGrossAmountMills;
      unknownGrossAmountMills += row.unknownGrossAmountMills;
      postedCreatorNetAmountMills += row.postedCreatorNetAmountMills;
      pendingCreatorNetAmountMills += row.pendingCreatorNetAmountMills;
      unknownCreatorNetAmountMills += row.unknownCreatorNetAmountMills;
      transactionCount += row.transactionCount;

      if (!lastTransactionAt || (row.lastTransactionAt && row.lastTransactionAt > lastTransactionAt)) {
        lastTransactionAt = row.lastTransactionAt;
      }
    }

    cursor = nextBusinessDate(cursor);
  }

  return {
    metrics: serializeWindowMetrics({
      grossAmountMills,
      creatorNetAmountMills,
      postedGrossAmountMills,
      pendingGrossAmountMills,
      unknownGrossAmountMills,
      postedCreatorNetAmountMills,
      pendingCreatorNetAmountMills,
      unknownCreatorNetAmountMills,
      transactionCount,
      lastTransactionAt,
    }),
  };
}

export async function getSpenderList(
  app: AppContext,
  principal: AuthPrincipal,
  query: SpenderListQuery,
): Promise<SpenderListResponse> {
  const scope = await resolveSpenderScope(app, principal, query);
  const { period, custom } = normalizePeriodInput(query);
  const periodMeta = toPeriodMetadata(
    scope.platform,
    period,
    custom,
    await resolveAsOf(app, scope),
  );
  const { sortBy, sortDir } = normalizeSortBy(period, query.sortBy, query.sortDir);
  const { fromBusinessDate, toBusinessDateInclusive } = resolveSpenderBusinessDateRangeForPlatform(
    scope.platform,
    period,
    new Date(),
    custom,
  );
  const ranked = await listRankedSpenders(app.db, {
    platform: scope.platform,
    pageIds: scope.pageIds,
    period: period === "lifetime" ? "lifetime" : "window",
    fromBusinessDate: fromBusinessDate ?? undefined,
    toBusinessDateExclusive: toBusinessDateInclusive
      ? nextBusinessDate(toBusinessDateInclusive)
      : undefined,
    query: query.query,
    sortBy,
    sortDir,
    limit: query.limit,
    offset: query.offset,
  });

  const comparisonRange = period === "lifetime"
    ? null
    : resolveComparisonRange(scope.platform, period, custom);
  const comparisonRows = comparisonRange
    ? await getSpenderWindowMetrics(app.db, {
      pageIds: scope.pageIds,
      fromBusinessDate: comparisonRange.fromBusinessDate,
      toBusinessDateExclusive: comparisonRange.toBusinessDateExclusive,
      fanIds: ranked.items.map((item) => item.fanId),
    })
    : [];
  const comparisonByFanId = new Map(comparisonRows.map((row) => [row.fanId, row]));
  const diagnostics = await getSpenderRevenueDiagnosticsForScope(app.db, {
    pageIds: scope.pageIds,
    fromBusinessDate: fromBusinessDate ?? null,
    toBusinessDateExclusive: toBusinessDateInclusive ? nextBusinessDate(toBusinessDateInclusive) : null,
  });

  return {
    scope: scope.responseScope,
    period: periodMeta,
    diagnostics: {
      totalGrossAmountMills: millsToNumber(diagnostics.totalGrossAmountMills),
      totalCreatorNetAmountMills: millsToNumber(diagnostics.totalCreatorNetAmountMills),
      attributedGrossAmountMills: millsToNumber(diagnostics.attributedGrossAmountMills),
      attributedCreatorNetAmountMills: millsToNumber(diagnostics.attributedCreatorNetAmountMills),
      unattributedGrossAmountMills: millsToNumber(diagnostics.unattributedGrossAmountMills),
      unattributedCreatorNetAmountMills: millsToNumber(diagnostics.unattributedCreatorNetAmountMills),
    },
    items: ranked.items.map((item) => ({
      fan: serializeFan(item),
      metrics: {
        window: period === "lifetime" ? null : serializeWindowMetrics(item),
        lifetime: serializeLifetimeMetrics(
          {
            grossAmountMills: item.lifetimeGrossAmountMills,
            creatorNetAmountMills: item.lifetimeCreatorNetAmountMills,
          },
          {
            grossAmountMills: item.lifetimeGrossAmountMills,
            creatorNetAmountMills: item.lifetimeCreatorNetAmountMills,
          },
        ),
        comparison: period === "lifetime"
          ? null
          : serializeComparison(item, comparisonByFanId.get(item.fanId)),
      },
    })),
    limit: query.limit,
    offset: query.offset,
    total: ranked.total,
  };
}

export async function getSpenderDetail(
  app: AppContext,
  principal: AuthPrincipal,
  identity: {
    platform: Platform;
    platformUserId: string;
  },
  query: SpenderDetailQuery,
): Promise<SpenderDetailResponse> {
  const scope = await resolveSpenderScope(app, principal, query);
  if (scope.platform !== identity.platform) {
    throw new BadRequestError("Spender identity platform must match the requested scope platform");
  }

  const fan = await findVisibleFanByIdentity(app.db, {
    platform: identity.platform,
    platformUserId: identity.platformUserId,
    pageIds: scope.pageIds,
  });
  if (!fan) {
    throw new NotFoundError(
      `Fan "${identity.platform}:${identity.platformUserId}" not visible in the requested scope`,
    );
  }

  const { period, custom } = normalizePeriodInput(query);
  const asOf = await resolveAsOf(app, scope);
  const periodMeta = toPeriodMetadata(scope.platform, period, custom, asOf);
  const scopeLifetimeRow = (
    await getSpenderLifetimeMetrics(app.db, {
      pageIds: scope.pageIds,
      fanIds: [fan.fanId],
    })
  )[0] ?? null;
  const platformLifetimeRow = await getScopedLifetimeTotalsForFan(app.db, {
    fanId: fan.fanId,
    platform: scope.platform,
    pageIds: scope.visiblePlatformPageIds,
  });

  let windowMetrics: SpenderDetailResponse["metrics"]["window"] = null;
  let comparison: SpenderDetailResponse["metrics"]["comparison"] = null;

  if (period !== "lifetime") {
    const currentRange = resolveSpenderBusinessDateRangeForPlatform(
      scope.platform,
      period,
      new Date(),
      custom,
    );
    const currentRow = (
      await getSpenderWindowMetrics(app.db, {
        pageIds: scope.pageIds,
        fromBusinessDate: currentRange.fromBusinessDate!,
        toBusinessDateExclusive: nextBusinessDate(currentRange.toBusinessDateInclusive!),
        fanIds: [fan.fanId],
      })
    )[0] ?? null;
    const comparisonRange = resolveComparisonRange(scope.platform, period, custom);
    const comparisonRow = comparisonRange
      ? (
        await getSpenderWindowMetrics(app.db, {
          pageIds: scope.pageIds,
          fromBusinessDate: comparisonRange.fromBusinessDate,
          toBusinessDateExclusive: comparisonRange.toBusinessDateExclusive,
          fanIds: [fan.fanId],
        })
      )[0] ?? null
      : null;

    windowMetrics = serializeWindowMetrics(currentRow);
    comparison = serializeComparison(currentRow, comparisonRow);
  }

  const pageMemberships = await getVisibleFanPageMemberships(app.db, {
    fanIds: [fan.fanId],
    pageIds: scope.visiblePlatformPageIds,
  });

  return {
    scope: scope.responseScope,
    fan: serializeFan(fan),
    period: periodMeta,
    metrics: {
      window: windowMetrics,
      lifetime: serializeLifetimeMetrics(scopeLifetimeRow, platformLifetimeRow),
      comparison,
    },
    pages: pageMemberships.map((row) => ({
      pageId: row.pageId,
      pageLabel: row.pageLabel,
      modelSlug: row.modelSlug,
      modelName: row.modelName,
      inScope: scope.pageIds.includes(row.pageId),
      grossAmountMills: millsToNumber(row.grossAmountMills),
      creatorNetAmountMills: millsToNumber(row.creatorNetAmountMills),
      lastTransactionAt: serializeTimestamp(row.lastTransactionAt),
      isFollower: row.isFollower,
      followerSince: serializeTimestamp(row.followerSince),
      isSubscriber: row.isSubscriber,
      subscriberSince: serializeTimestamp(row.subscriberSince),
      subscriptionExpiresAt: serializeTimestamp(row.subscriptionExpiresAt),
      autoRenew: row.autoRenew,
    })),
  };
}

export async function getSpenderSeries(
  app: AppContext,
  principal: AuthPrincipal,
  identity: {
    platform: Platform;
    platformUserId: string;
  },
  query: SpenderSeriesQuery,
): Promise<SpenderSeriesResponse> {
  const scope = await resolveSpenderScope(app, principal, query);
  if (scope.platform !== identity.platform) {
    throw new BadRequestError("Spender identity platform must match the requested scope platform");
  }

  const fan = await findVisibleFanByIdentity(app.db, {
    platform: identity.platform,
    platformUserId: identity.platformUserId,
    pageIds: scope.pageIds,
  });
  if (!fan) {
    throw new NotFoundError(
      `Fan "${identity.platform}:${identity.platformUserId}" not visible in the requested scope`,
    );
  }

  const { period, custom } = normalizePeriodInput(query);
  const timeZone = resolveBusinessTimeZone(scope.platform);
  const todayBusinessDate = toBusinessDate(new Date(), timeZone);
  let fromBusinessDate: string;
  let toBusinessDateInclusive: string;

  if (period === "lifetime") {
    fromBusinessDate = await getEarliestSpenderBusinessDateForFan(app.db, {
      fanId: fan.fanId,
      pageIds: scope.pageIds,
    }) ?? todayBusinessDate;
    toBusinessDateInclusive = todayBusinessDate;
  } else {
    const resolved = resolveSpenderBusinessDateRangeForPlatform(
      scope.platform,
      period,
      new Date(),
      custom,
    );
    fromBusinessDate = resolved.fromBusinessDate!;
    toBusinessDateInclusive = resolved.toBusinessDateInclusive!;
  }

  const granularity = query.granularity === "auto"
    ? resolveAutoSpenderSeriesGranularity(fromBusinessDate, toBusinessDateInclusive)
    : query.granularity;
  const rows = await getSpenderDailySeriesRows(app.db, {
    fanId: fan.fanId,
    pageIds: scope.pageIds,
    fromBusinessDate,
    toBusinessDateExclusive: nextBusinessDate(toBusinessDateInclusive),
  });
  const rowsByBusinessDate = new Map(rows.map((row) => [row.businessDate, row]));
  const buckets = buildSeriesBuckets(fromBusinessDate, toBusinessDateInclusive, granularity);

  return {
    scope: scope.responseScope,
    fan: serializeFan(fan),
    period: {
      timeZone,
      fromBusinessDate,
      toBusinessDateInclusive,
      asOf: serializeTimestamp(await resolveAsOf(app, scope)),
    },
    granularity,
    items: buckets.map((bucket) => ({
      fromBusinessDate: bucket.fromBusinessDate,
      toBusinessDateInclusive: bucket.toBusinessDateInclusive,
      ...aggregateSeriesBucket(rowsByBusinessDate, bucket),
    })),
  };
}

export async function getSpenderBatch(
  app: AppContext,
  principal: AuthPrincipal,
  body: SpenderBatchBody,
): Promise<SpenderBatchResponse> {
  const scope = await resolveSpenderScope(app, principal, body);
  const { period, custom } = normalizePeriodInput(body);

  for (const fan of body.fans) {
    if (fan.platform !== scope.platform) {
      throw new BadRequestError("Batch spender requests cannot mix platforms");
    }
  }

  const visibleFans = await findVisibleFansByPlatformUserIds(app.db, {
    platform: scope.platform,
    platformUserIds: Array.from(new Set(body.fans.map((fan) => fan.platformUserId))),
    pageIds: scope.pageIds,
  });
  const fansByPlatformUserId = new Map(visibleFans.map((fan) => [fan.platformUserId, fan]));
  const fanIds = visibleFans.map((fan) => fan.fanId);
  const scopeLifetimeRows = await getSpenderLifetimeMetrics(app.db, {
    pageIds: scope.pageIds,
    fanIds,
  });
  const platformLifetimeRows = await getSpenderLifetimeMetrics(app.db, {
    pageIds: scope.visiblePlatformPageIds,
    fanIds,
  });
  const scopeLifetimeByFanId = new Map(scopeLifetimeRows.map((row) => [row.fanId, row]));
  const platformLifetimeByFanId = new Map(platformLifetimeRows.map((row) => [row.fanId, row]));

  let currentWindowByFanId = new Map<number, SpenderWindowMetricRow>();
  let comparisonByFanId = new Map<number, SpenderWindowMetricRow>();

  if (period !== "lifetime" && fanIds.length > 0) {
    const currentRange = resolveSpenderBusinessDateRangeForPlatform(
      scope.platform,
      period,
      new Date(),
      custom,
    );
    const currentRows = await getSpenderWindowMetrics(app.db, {
      pageIds: scope.pageIds,
      fromBusinessDate: currentRange.fromBusinessDate!,
      toBusinessDateExclusive: nextBusinessDate(currentRange.toBusinessDateInclusive!),
      fanIds,
    });
    currentWindowByFanId = new Map(currentRows.map((row) => [row.fanId, row]));

    const comparisonRange = resolveComparisonRange(scope.platform, period, custom);
    if (comparisonRange) {
      const comparisonRows = await getSpenderWindowMetrics(app.db, {
        pageIds: scope.pageIds,
        fromBusinessDate: comparisonRange.fromBusinessDate,
        toBusinessDateExclusive: comparisonRange.toBusinessDateExclusive,
        fanIds,
      });
      comparisonByFanId = new Map(comparisonRows.map((row) => [row.fanId, row]));
    }
  }

  return {
    scope: scope.responseScope,
    period: toPeriodMetadata(
      scope.platform,
      period,
      custom,
      await resolveAsOf(app, scope),
    ),
    items: body.fans.map((requestedFan) => {
      const fan = fansByPlatformUserId.get(requestedFan.platformUserId);
      if (!fan) {
        return {
          requestedFan,
          found: false,
          fan: null,
          metrics: null,
        };
      }

      const currentMetrics = currentWindowByFanId.get(fan.fanId) ?? null;
      const previousMetrics = comparisonByFanId.get(fan.fanId) ?? null;

      return {
        requestedFan,
        found: true,
        fan: serializeFan(fan),
        metrics: {
          window: period === "lifetime" ? null : serializeWindowMetrics(currentMetrics),
          lifetime: serializeLifetimeMetrics(
            scopeLifetimeByFanId.get(fan.fanId) ?? null,
            platformLifetimeByFanId.get(fan.fanId) ?? null,
          ),
          comparison: period === "lifetime" ? null : serializeComparison(currentMetrics, previousMetrics),
        },
      };
    }),
  };
}

export async function searchVisibleFans(
  app: AppContext,
  principal: AuthPrincipal,
  query: FansSearchQuery,
): Promise<FansSearchResponse> {
  const scope = await resolveSpenderScope(app, principal, query);
  const results = await searchFansInScope(app.db, {
    platform: scope.platform,
    pageIds: scope.pageIds,
    query: query.query,
    limit: query.limit,
    offset: query.offset,
  });
  const memberships = await getVisibleFanPageMemberships(app.db, {
    fanIds: results.items.map((item) => item.fanId),
    pageIds: scope.pageIds,
  });
  const membershipsByFanId = new Map<number, typeof memberships>();

  for (const membership of memberships) {
    const current = membershipsByFanId.get(membership.fanId) ?? [];
    current.push(membership);
    membershipsByFanId.set(membership.fanId, current);
  }

  return {
    scope: scope.responseScope,
    items: results.items.map((item) => ({
      fan: serializeFan(item),
      matchKind: item.matchKind,
      matchedValue: item.matchedValue,
      pages: (membershipsByFanId.get(item.fanId) ?? []).map((membership) => ({
        pageId: membership.pageId,
        pageLabel: membership.pageLabel,
        modelSlug: membership.modelSlug,
        modelName: membership.modelName,
        isFollower: membership.isFollower,
        followerSince: serializeTimestamp(membership.followerSince),
        isSubscriber: membership.isSubscriber,
        subscriberSince: serializeTimestamp(membership.subscriberSince),
        subscriptionExpiresAt: serializeTimestamp(membership.subscriptionExpiresAt),
        autoRenew: membership.autoRenew,
      })),
    })),
    limit: query.limit,
    offset: query.offset,
    total: results.total,
  };
}
