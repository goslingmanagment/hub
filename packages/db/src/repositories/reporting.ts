import { and, asc, desc, eq, gte, ilike, inArray, lt, ne, or, sql } from "drizzle-orm";

import { toBusinessDate, type PeriodBounds } from "@fansly-connect/shared";
import type { Database } from "../client.ts";
import {
  dailyRevenue,
  dailyFollowers,
  dailySubscribers,
  fanPages,
  fans,
  models,
  pageFollows,
  pageSubscriptions,
  platformAccounts,
  transactions,
} from "../schema.ts";

function applyPageScope<T>(clauses: T[], pageIds?: number[]) {
  if (pageIds !== undefined) {
    if (pageIds.length === 0) {
      return { scoped: true, clauses };
    }
    clauses.push(inArray(platformAccounts.id, pageIds) as T);
  }

  return { scoped: false, clauses };
}

export async function findPageSummaryByLabel(db: Database, label: string) {
  const [row] = await db.select({
    id: platformAccounts.id,
    label: platformAccounts.label,
    platform: platformAccounts.platform,
    username: platformAccounts.username,
    displayName: platformAccounts.displayName,
    followerCount: platformAccounts.followerCount,
    subscriberCount: platformAccounts.subscriberCount,
    lastLightSyncAt: platformAccounts.lastLightSyncAt,
    lastFollowerSyncAt: platformAccounts.lastFollowerSyncAt,
    modelSlug: models.slug,
    modelName: models.name,
  }).from(platformAccounts)
    .innerJoin(models, eq(models.id, platformAccounts.modelId))
    .where(eq(platformAccounts.label, label));

  return row ?? null;
}

export async function listVisiblePages(db: Database, pageIds?: number[]) {
  const clauses: Array<any> = [];
  const { scoped } = applyPageScope(clauses, pageIds);
  if (scoped && pageIds?.length === 0) {
    return [];
  }

  return db.select({
    id: platformAccounts.id,
    label: platformAccounts.label,
    platform: platformAccounts.platform,
    username: platformAccounts.username,
    displayName: platformAccounts.displayName,
    followerCount: platformAccounts.followerCount,
    subscriberCount: platformAccounts.subscriberCount,
    lastLightSyncAt: platformAccounts.lastLightSyncAt,
    lastFollowerSyncAt: platformAccounts.lastFollowerSyncAt,
    modelSlug: models.slug,
    modelName: models.name,
  }).from(platformAccounts)
    .innerJoin(models, eq(models.id, platformAccounts.modelId))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(models.slug, platformAccounts.label);
}

export async function listVisibleModels(db: Database, pageIds?: number[]) {
  if (pageIds !== undefined && pageIds.length === 0) {
    return [];
  }

  const clauses: Array<any> = [];
  if (pageIds !== undefined) {
    clauses.push(inArray(platformAccounts.id, pageIds));
  }

  return db.select({
    id: models.id,
    slug: models.slug,
    name: models.name,
    pageCount: sql<number>`count(${platformAccounts.id})::int`,
  }).from(models)
    .innerJoin(platformAccounts, eq(platformAccounts.modelId, models.id))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .groupBy(models.id, models.slug, models.name)
    .orderBy(models.slug);
}

export async function findVisibleModel(db: Database, modelSlug: string, pageIds?: number[]) {
  if (pageIds !== undefined && pageIds.length === 0) {
    return null;
  }

  const clauses = [eq(models.slug, modelSlug)];
  if (pageIds !== undefined) {
    clauses.push(inArray(platformAccounts.id, pageIds));
  }

  const [row] = await db.select({
    id: models.id,
    slug: models.slug,
    name: models.name,
    pageCount: sql<number>`count(${platformAccounts.id})::int`,
  }).from(models)
    .innerJoin(platformAccounts, eq(platformAccounts.modelId, models.id))
    .where(and(...clauses))
    .groupBy(models.id, models.slug, models.name);

  return row ?? null;
}

function buildTransactionScopeClauses(
  input: {
    pageIds?: number[];
    period?: PeriodBounds;
    canonicalType?: string;
    transactionState?: string;
    excludePayoutReversal?: boolean;
  },
) {
  const clauses = [];

  if (input.excludePayoutReversal) {
    clauses.push(ne(transactions.canonicalType, "payout_reversal"));
  }

  if (input.pageIds !== undefined) {
    if (input.pageIds.length === 0) {
      return null;
    }
    clauses.push(inArray(transactions.platformAccountId, input.pageIds));
  }

  if (input.period?.from) {
    clauses.push(gte(transactions.occurredAt, input.period.from));
  }
  if (input.period?.to) {
    clauses.push(lt(transactions.occurredAt, input.period.to));
  }
  if (input.canonicalType) {
    clauses.push(eq(transactions.canonicalType, input.canonicalType as typeof transactions.$inferSelect.canonicalType));
  }
  if (input.transactionState) {
    clauses.push(eq(transactions.transactionState, input.transactionState as typeof transactions.$inferSelect.transactionState));
  }

  return clauses;
}

function buildRevenueRollupClauses(
  input: {
    pageIds?: number[];
    fromBusinessDate?: string | null;
    toBusinessDate?: string | null;
  },
) {
  const clauses = [ne(dailyRevenue.canonicalType, "payout_reversal")];

  if (input.pageIds !== undefined) {
    if (input.pageIds.length === 0) {
      return null;
    }
    clauses.push(inArray(dailyRevenue.platformAccountId, input.pageIds));
  }

  if (input.fromBusinessDate) {
    clauses.push(gte(dailyRevenue.businessDate, input.fromBusinessDate));
  }
  if (input.toBusinessDate) {
    clauses.push(lt(dailyRevenue.businessDate, input.toBusinessDate));
  }

  return clauses;
}

export async function getRevenuePageTotals(
  db: Database,
  input: {
    pageIds?: number[];
    period: PeriodBounds;
    modelSlug?: string;
  },
) {
  const clauses = buildRevenueRollupClauses({
    pageIds: input.pageIds,
    fromBusinessDate: input.period.from ? toBusinessDate(input.period.from) : null,
    toBusinessDate: input.period.to ? toBusinessDate(input.period.to) : null,
  });

  if (!clauses) {
    return [];
  }

  if (input.modelSlug) {
    clauses.push(eq(models.slug, input.modelSlug));
  }

  return db.select({
    pageId: platformAccounts.id,
    pageLabel: platformAccounts.label,
    modelId: models.id,
    modelSlug: models.slug,
    modelName: models.name,
    totalNetMills: sql<bigint>`coalesce(sum(${dailyRevenue.netAmountMills}), 0)::bigint`,
  }).from(dailyRevenue)
    .innerJoin(platformAccounts, eq(platformAccounts.id, dailyRevenue.platformAccountId))
    .innerJoin(models, eq(models.id, platformAccounts.modelId))
    .where(and(...clauses))
    .groupBy(platformAccounts.id, platformAccounts.label, models.id, models.slug, models.name)
    .orderBy(models.slug, platformAccounts.label);
}

export async function getRevenueBreakdownForScope(
  db: Database,
  input: {
    pageIds?: number[];
    period: PeriodBounds;
  },
) {
  const clauses = buildRevenueRollupClauses({
    pageIds: input.pageIds,
    fromBusinessDate: input.period.from ? toBusinessDate(input.period.from) : null,
    toBusinessDate: input.period.to ? toBusinessDate(input.period.to) : null,
  });

  if (!clauses) {
    return [];
  }

  return db.select({
    canonicalType: dailyRevenue.canonicalType,
    total: sql<bigint>`coalesce(sum(${dailyRevenue.netAmountMills}), 0)::bigint`,
  }).from(dailyRevenue)
    .where(and(...clauses))
    .groupBy(dailyRevenue.canonicalType)
    .orderBy(dailyRevenue.canonicalType);
}

export async function listTransactionsForPage(
  db: Database,
  input: {
    pageId: number;
    limit: number;
    offset: number;
    canonicalType?: string;
    transactionState?: string;
  },
) {
  const clauses = buildTransactionScopeClauses({
    pageIds: [input.pageId],
    canonicalType: input.canonicalType,
    transactionState: input.transactionState,
    excludePayoutReversal: false,
  });

  if (!clauses) {
    return {
      total: 0,
      items: [],
    };
  }

  const [countRow] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(transactions).where(and(...clauses));

  const items = await db.select({
    transactionId: transactions.transactionId,
    rawType: transactions.rawType,
    canonicalType: transactions.canonicalType,
    transactionState: transactions.transactionState,
    amountMills: transactions.amountMills,
    destinationAmountMills: transactions.destinationAmountMills,
    netAmountMills: transactions.netAmountMills,
    walletId: transactions.walletId,
    correlationId: transactions.correlationId,
    correlationAccountId: transactions.correlationAccountId,
    occurredAt: transactions.occurredAt,
    sourceUpdatedAt: transactions.sourceUpdatedAt,
    fanPlatformUserId: fans.platformUserId,
    fanUsername: fans.username,
    fanDisplayName: fans.displayName,
  }).from(transactions)
    .leftJoin(fans, eq(fans.id, transactions.fanId))
    .where(and(...clauses))
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    items,
  };
}

export async function listSubscribersForPage(
  db: Database,
  input: {
    pageId: number;
    limit: number;
    offset: number;
  },
) {
  const clauses = and(
    eq(pageSubscriptions.platformAccountId, input.pageId),
    eq(pageSubscriptions.isCurrent, true),
  );

  const [countRow] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(pageSubscriptions)
    .innerJoin(fans, eq(fans.id, pageSubscriptions.fanId))
    .where(clauses);

  const items = await db.select({
    platformSubscriptionId: pageSubscriptions.platformSubscriptionId,
    endsAt: pageSubscriptions.endsAt,
    autoRenew: pageSubscriptions.autoRenew,
    subscriptionTierName: pageSubscriptions.subscriptionTierName,
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
  }).from(pageSubscriptions)
    .innerJoin(fans, eq(fans.id, pageSubscriptions.fanId))
    .where(clauses)
    .orderBy(asc(pageSubscriptions.endsAt), asc(pageSubscriptions.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    items,
  };
}

export async function listSubscriberDailyForPage(
  db: Database,
  input: {
    pageId: number;
    fromBusinessDate?: string | null;
    toBusinessDate?: string | null;
  },
) {
  const clauses = [eq(dailySubscribers.platformAccountId, input.pageId)];
  if (input.fromBusinessDate) {
    clauses.push(gte(dailySubscribers.businessDate, input.fromBusinessDate));
  }
  if (input.toBusinessDate) {
    clauses.push(lt(dailySubscribers.businessDate, input.toBusinessDate));
  }

  return db.select({
    businessDate: dailySubscribers.businessDate,
    newSubscribers: dailySubscribers.newSubscribers,
    activeSubscribers: dailySubscribers.activeSubscribers,
  }).from(dailySubscribers)
    .where(and(...clauses))
    .orderBy(dailySubscribers.businessDate);
}

export async function listFollowersForPage(
  db: Database,
  input: {
    pageId: number;
    limit: number;
    offset: number;
  },
) {
  const clauses = and(
    eq(pageFollows.platformAccountId, input.pageId),
    eq(pageFollows.isActive, true),
  );

  const [countRow] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(pageFollows)
    .innerJoin(fans, eq(fans.id, pageFollows.fanId))
    .where(clauses);

  const items = await db.select({
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
    followedAt: pageFollows.followedAt,
  }).from(pageFollows)
    .innerJoin(fans, eq(fans.id, pageFollows.fanId))
    .where(clauses)
    .orderBy(desc(pageFollows.followedAt), desc(pageFollows.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    items,
  };
}

export async function listFollowerDailyForPage(
  db: Database,
  input: {
    pageId: number;
    fromBusinessDate?: string | null;
    toBusinessDate?: string | null;
  },
) {
  const clauses = [eq(dailyFollowers.platformAccountId, input.pageId)];
  if (input.fromBusinessDate) {
    clauses.push(gte(dailyFollowers.businessDate, input.fromBusinessDate));
  }
  if (input.toBusinessDate) {
    clauses.push(lt(dailyFollowers.businessDate, input.toBusinessDate));
  }

  return db.select({
    businessDate: dailyFollowers.businessDate,
    newFollowers: dailyFollowers.newFollowers,
    knownTotalFollowers: dailyFollowers.knownTotalFollowers,
  }).from(dailyFollowers)
    .where(and(...clauses))
    .orderBy(dailyFollowers.businessDate);
}

export async function listFansForPage(
  db: Database,
  input: {
    pageId: number;
    limit: number;
    offset: number;
    query?: string;
  },
) {
  const clauses = [eq(fanPages.platformAccountId, input.pageId)];
  if (input.query) {
    const pattern = `%${input.query}%`;
    clauses.push(or(
      ilike(fans.platformUserId, pattern),
      ilike(sql`coalesce(${fans.username}, '')`, pattern),
      ilike(sql`coalesce(${fans.displayName}, '')`, pattern),
    )!);
  }

  const [countRow] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .where(and(...clauses));

  const items = await db.select({
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
    totalCreatorNetMills: fanPages.totalCreatorNetMills,
    currency: fanPages.currency,
    isFollower: fanPages.isFollower,
    followerSince: fanPages.followerSince,
    isSubscriber: fanPages.isSubscriber,
    subscriberSince: fanPages.subscriberSince,
    subscriptionExpiresAt: fanPages.subscriptionExpiresAt,
    autoRenew: fanPages.autoRenew,
    lastTransactionAt: fanPages.lastTransactionAt,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .where(and(...clauses))
    .orderBy(desc(fanPages.totalCreatorNetMills), desc(fanPages.lastTransactionAt), asc(fans.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    items,
  };
}

export async function findPlatformFan(
  db: Database,
  platform: "fansly" | "onlyfans",
  platformUserId: string,
) {
  return db.query.fans.findFirst({
    where: and(
      eq(fans.platform, platform),
      eq(fans.platformUserId, platformUserId),
    ),
  });
}

export async function findFanOnPage(db: Database, pageId: number, platformUserId: string) {
  const [row] = await db.select({
    fanId: fans.id,
    platform: fans.platform,
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
    createdAtExternal: fans.createdAtExternal,
    pageId: platformAccounts.id,
    pageLabel: platformAccounts.label,
    modelSlug: models.slug,
    modelName: models.name,
    totalCreatorNetMills: fanPages.totalCreatorNetMills,
    currency: fanPages.currency,
    isFollower: fanPages.isFollower,
    followerSince: fanPages.followerSince,
    isSubscriber: fanPages.isSubscriber,
    subscriberSince: fanPages.subscriberSince,
    subscriptionExpiresAt: fanPages.subscriptionExpiresAt,
    autoRenew: fanPages.autoRenew,
    lastTransactionAt: fanPages.lastTransactionAt,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .innerJoin(platformAccounts, eq(platformAccounts.id, fanPages.platformAccountId))
    .innerJoin(models, eq(models.id, platformAccounts.modelId))
    .where(and(
      eq(fanPages.platformAccountId, pageId),
      eq(fans.platformUserId, platformUserId),
    ));

  return row ?? null;
}

export async function listFanPageContexts(
  db: Database,
  fanId: number,
  pageIds?: number[],
) {
  const clauses = [eq(fanPages.fanId, fanId)];
  if (pageIds !== undefined) {
    if (pageIds.length === 0) {
      return [];
    }
    clauses.push(inArray(fanPages.platformAccountId, pageIds));
  }

  return db.select({
    fanId: fans.id,
    platform: fans.platform,
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
    createdAtExternal: fans.createdAtExternal,
    pageId: platformAccounts.id,
    pageLabel: platformAccounts.label,
    modelSlug: models.slug,
    modelName: models.name,
    totalCreatorNetMills: fanPages.totalCreatorNetMills,
    currency: fanPages.currency,
    isFollower: fanPages.isFollower,
    followerSince: fanPages.followerSince,
    isSubscriber: fanPages.isSubscriber,
    subscriberSince: fanPages.subscriberSince,
    subscriptionExpiresAt: fanPages.subscriptionExpiresAt,
    autoRenew: fanPages.autoRenew,
    lastTransactionAt: fanPages.lastTransactionAt,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .innerJoin(platformAccounts, eq(platformAccounts.id, fanPages.platformAccountId))
    .innerJoin(models, eq(models.id, platformAccounts.modelId))
    .where(and(...clauses))
    .orderBy(models.slug, platformAccounts.label);
}

export async function getPlatformTotalSpendForFan(db: Database, fanId: number) {
  const [row] = await db.select({
    total: sql<bigint>`coalesce(sum(${fanPages.totalCreatorNetMills}), 0)::bigint`,
  }).from(fanPages)
    .where(eq(fanPages.fanId, fanId));

  return row?.total ?? 0n;
}
