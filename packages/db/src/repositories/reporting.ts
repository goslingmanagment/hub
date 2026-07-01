import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

import {
  getTransactionClassification,
  reportableTransactionTypes,
  resolveBusinessTimeZone,
  toBusinessDate,
  type PeriodBounds,
  type Platform,
} from "@agency_hub_core/shared";
import type { Database } from "../client.ts";
import {
  dailyRevenue,
  dailyFollowers,
  dailySubscribers,
  fanPageAliases,
  fanPages,
  fans,
  fanUsernameAliases,
  models,
  pageDmConversations,
  pageFollows,
  pageSubscriptions,
  pages,
  pageCredentials,
  egressEndpoints,
  spenderLifetimePage,
  transactions,
} from "../schema.ts";
import {
  buildContainsSearchPattern,
  ilikeEscaped,
  pageAliasHistoryMatchSql,
  pageAliasMatchSql,
} from "./search.ts";
import { egressKeySql } from "./egress.ts";

function applyPageScope<T>(clauses: T[], pageIds?: number[]) {
  if (pageIds !== undefined) {
    if (pageIds.length === 0) {
      return { scoped: true, clauses };
    }
    clauses.push(inArray(pages.id, pageIds) as T);
  }

  return { scoped: false, clauses };
}

export async function findPageSummaryByLabel(db: Database, label: string) {
  const [row] = await db.select({
    id: pages.id,
    label: pages.label,
    platform: pages.platform,
    modelId: pages.modelId,
    username: pages.username,
    displayName: pages.displayName,
    followerCount: pages.followerCount,
    subscriberCount: pages.subscriberCount,
    lastLightSyncAt: pages.lastLightSyncAt,
    lastFollowerSyncAt: pages.lastFollowerSyncAt,
    modelSlug: models.slug,
    modelName: models.name,
    hasCredentials: sql<boolean>`${pageCredentials.id} is not null`,
  }).from(pages)
    .innerJoin(models, eq(models.id, pages.modelId))
    .leftJoin(pageCredentials, eq(pageCredentials.platformAccountId, pages.id))
    .where(eq(pages.label, label));

  return row ?? null;
}

export async function listVisiblePages(db: Database, pageIds?: number[]) {
  const clauses: Array<any> = [];
  const { scoped } = applyPageScope(clauses, pageIds);
  if (scoped && pageIds?.length === 0) {
    return [];
  }

  return db.select({
    id: pages.id,
    label: pages.label,
    platform: pages.platform,
    username: pages.username,
    displayName: pages.displayName,
    followerCount: pages.followerCount,
    subscriberCount: pages.subscriberCount,
    lastLightSyncAt: pages.lastLightSyncAt,
    lastFollowerSyncAt: pages.lastFollowerSyncAt,
    ofapiAccountId: pages.ofapiAccountId,
    ofapiAuthStatus: pages.ofapiAuthStatus,
    ofapiAuthChangedAt: pages.ofapiAuthChangedAt,
    modelSlug: models.slug,
    modelName: models.name,
    hasCredentials: sql<boolean>`${pageCredentials.id} is not null`,
    proxyUrl: egressEndpoints.url,
    egressKey: egressKeySql(egressEndpoints.rateLimitScopeKey, egressEndpoints.url),
    proxyHasAuth: sql<boolean>`${egressEndpoints.encryptedAuth} is not null`,
  }).from(pages)
    .innerJoin(models, eq(models.id, pages.modelId))
    .leftJoin(pageCredentials, eq(pageCredentials.platformAccountId, pages.id))
    .leftJoin(egressEndpoints, eq(egressEndpoints.platformAccountId, pages.id))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .orderBy(models.sortOrder, models.slug, pages.label);
}

export async function listVisibleModels(db: Database, pageIds?: number[]) {
  if (pageIds !== undefined && pageIds.length === 0) {
    return [];
  }

  const clauses: Array<any> = [];
  if (pageIds !== undefined) {
    clauses.push(inArray(pages.id, pageIds));
  }

  return db.select({
    id: models.id,
    slug: models.slug,
    name: models.name,
    pageCount: sql<number>`count(${pages.id})::int`,
  }).from(models)
    .innerJoin(pages, eq(pages.modelId, models.id))
    .where(clauses.length > 0 ? and(...clauses) : undefined)
    .groupBy(models.id, models.slug, models.name)
    .orderBy(models.sortOrder, models.slug);
}

export async function findVisibleModel(db: Database, modelSlug: string, pageIds?: number[]) {
  if (pageIds !== undefined && pageIds.length === 0) {
    return null;
  }

  const clauses = [eq(models.slug, modelSlug)];
  if (pageIds !== undefined) {
    clauses.push(inArray(pages.id, pageIds));
  }

  const [row] = await db.select({
    id: models.id,
    slug: models.slug,
    name: models.name,
    pageCount: sql<number>`count(${pages.id})::int`,
  }).from(models)
    .innerJoin(pages, eq(pages.modelId, models.id))
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
    excludeExcludedTypes?: boolean;
  },
) {
  const clauses = [eq(transactions.isActive, true)];

  if (input.excludeExcludedTypes) {
    clauses.push(
      inArray(
        transactions.canonicalType,
        reportableTransactionTypes as Array<typeof transactions.$inferSelect.canonicalType>,
      ),
    );
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
  const clauses = [
    inArray(
      dailyRevenue.canonicalType,
      reportableTransactionTypes as Array<typeof dailyRevenue.$inferSelect.canonicalType>,
    ),
  ];

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
    platform: Platform;
    pageIds?: number[];
    period: PeriodBounds;
    modelSlug?: string;
  },
) {
  const timeZone = resolveBusinessTimeZone(input.platform);
  const clauses = buildRevenueRollupClauses({
    pageIds: input.pageIds,
    fromBusinessDate: input.period.from ? toBusinessDate(input.period.from, timeZone) : null,
    toBusinessDate: input.period.to ? toBusinessDate(input.period.to, timeZone) : null,
  });

  if (!clauses) {
    return [];
  }

  if (input.modelSlug) {
    clauses.push(eq(models.slug, input.modelSlug));
  }

  return db.select({
    pageId: pages.id,
    pageLabel: pages.label,
    modelId: models.id,
    modelSlug: models.slug,
    modelName: models.name,
    netEarningsMills: sql<bigint>`coalesce(sum(${dailyRevenue.creatorNetAmountMills}), 0)::bigint`,
  }).from(dailyRevenue)
    .innerJoin(pages, eq(pages.id, dailyRevenue.platformAccountId))
    .innerJoin(models, eq(models.id, pages.modelId))
    .where(and(...clauses))
    .groupBy(pages.id, pages.label, models.id, models.slug, models.name)
    .orderBy(models.slug, pages.label);
}

export async function getRevenuePageTotalsForExactPeriod(
  db: Database,
  input: {
    pageIds?: number[];
    period: PeriodBounds;
    modelSlug?: string;
  },
) {
  const clauses = buildTransactionScopeClauses({
    pageIds: input.pageIds,
    period: input.period,
    excludeExcludedTypes: true,
  });

  if (!clauses) {
    return [];
  }

  if (input.modelSlug) {
    clauses.push(eq(models.slug, input.modelSlug));
  }

  return db.select({
    pageId: pages.id,
    pageLabel: pages.label,
    modelId: models.id,
    modelSlug: models.slug,
    modelName: models.name,
    netEarningsMills: sql<bigint>`coalesce(sum(${transactions.creatorNetAmountMills}), 0)::bigint`,
  }).from(transactions)
    .innerJoin(pages, eq(pages.id, transactions.platformAccountId))
    .innerJoin(models, eq(models.id, pages.modelId))
    .where(and(...clauses))
    .groupBy(pages.id, pages.label, models.id, models.slug, models.name)
    .orderBy(models.slug, pages.label);
}

export async function getRevenueBreakdownForScope(
  db: Database,
  input: {
    platform: Platform;
    pageIds?: number[];
    period: PeriodBounds;
  },
) {
  const timeZone = resolveBusinessTimeZone(input.platform);
  const clauses = buildRevenueRollupClauses({
    pageIds: input.pageIds,
    fromBusinessDate: input.period.from ? toBusinessDate(input.period.from, timeZone) : null,
    toBusinessDate: input.period.to ? toBusinessDate(input.period.to, timeZone) : null,
  });

  if (!clauses) {
    return [];
  }

  const rows = await db.select({
    canonicalType: dailyRevenue.canonicalType,
    netAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.creatorNetAmountMills}), 0)::bigint`,
  }).from(dailyRevenue)
    .where(and(...clauses))
    .groupBy(dailyRevenue.canonicalType)
    .orderBy(dailyRevenue.canonicalType);

  return rows.map((row) => ({
    ...row,
    bucket: getTransactionClassification(row.canonicalType).bucket,
  }));
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
    excludeExcludedTypes: false,
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
    amountMills: transactions.grossAmountMills,
    destinationAmountMills: transactions.sourceDestinationAmountMills,
    netAmountMills: transactions.creatorNetAmountMills,
    walletId: transactions.walletId,
    correlationId: transactions.correlationId,
    correlationAccountId: transactions.correlationAccountId,
    occurredAt: transactions.occurredAt,
    sourceUpdatedAt: transactions.sourceUpdatedAt,
    fanPlatformUserId: sql<string | null>`case when ${fans.deletedDetectedAt} is null then ${fans.platformUserId} else null end`,
    fanUsername: sql<string | null>`case when ${fans.deletedDetectedAt} is null then ${fans.username} else null end`,
    fanDisplayName: sql<string | null>`case when ${fans.deletedDetectedAt} is null then ${fans.displayName} else null end`,
    fanPageAlias: sql<string | null>`case when ${fans.deletedDetectedAt} is null then ${fanPages.pageAlias} else null end`,
  }).from(transactions)
    .leftJoin(fans, eq(fans.id, transactions.fanId))
    .leftJoin(fanPages, and(
      eq(fanPages.platformAccountId, input.pageId),
      eq(fanPages.fanId, transactions.fanId),
    ))
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
    query?: string;
    expiringWithinDays?: number;
    startedWithinHours?: number;
    autoRenew?: boolean;
  },
) {
  const conditions = [
    eq(pageSubscriptions.platformAccountId, input.pageId),
    eq(pageSubscriptions.isCurrent, true),
    sql`${fans.deletedDetectedAt} is null`,
  ];

  if (input.query) {
    const pattern = buildContainsSearchPattern(input.query);
    if (pattern) {
      conditions.push(or(
        ilikeEscaped(fans.platformUserId, pattern),
        pageAliasMatchSql({
          fanId: fans.id,
          platformAccountId: pageSubscriptions.platformAccountId,
          pattern,
        }),
        pageAliasHistoryMatchSql({
          fanId: fans.id,
          platformAccountId: pageSubscriptions.platformAccountId,
          pattern,
        }),
        ilikeEscaped(sql`coalesce(${fans.username}, '')`, pattern),
        ilikeEscaped(sql`coalesce(${fans.displayName}, '')`, pattern),
        sql`exists (
          select 1
          from ${fanUsernameAliases} fua
          where fua.fan_id = ${fans.id}
            and fua.username ilike ${pattern} escape '\\'
        )`,
      )!);
    }
  }

  if (input.expiringWithinDays != null) {
    const now = new Date();
    const cutoff = new Date(now.getTime() + input.expiringWithinDays * 86_400_000);
    conditions.push(gte(pageSubscriptions.endsAt, now));
    conditions.push(lt(pageSubscriptions.endsAt, cutoff));
  }

  if (input.startedWithinHours != null) {
    const cutoff = new Date(Date.now() - input.startedWithinHours * 60 * 60 * 1000);
    conditions.push(gte(pageSubscriptions.sourceCreatedAt, cutoff));
  }

  if (input.autoRenew != null) {
    conditions.push(eq(pageSubscriptions.autoRenew, input.autoRenew));
  }

  const clauses = and(...conditions);
  const rows = await db.select({
    total: sql<number>`count(*) over()::int`,
    platformSubscriptionId: pageSubscriptions.platformSubscriptionId,
    endsAt: pageSubscriptions.endsAt,
    autoRenew: pageSubscriptions.autoRenew,
    autoRenewOffDetectedAt: pageSubscriptions.autoRenewOffDetectedAt,
    subscriptionTierName: pageSubscriptions.subscriptionTierName,
    sourceCreatedAt: pageSubscriptions.sourceCreatedAt,
    platformUserId: fans.platformUserId,
    pageAlias: fanPages.pageAlias,
    username: fans.username,
    displayName: fans.displayName,
    totalCreatorNetAmountMills: sql<bigint>`coalesce(${spenderLifetimePage.creatorNetAmountMills}, 0)::bigint`,
    lastTransactionAt: spenderLifetimePage.lastTransactionAt,
  }).from(pageSubscriptions)
    .innerJoin(fans, eq(fans.id, pageSubscriptions.fanId))
    .innerJoin(fanPages, and(
      eq(fanPages.platformAccountId, pageSubscriptions.platformAccountId),
      eq(fanPages.fanId, pageSubscriptions.fanId),
    ))
    .leftJoin(spenderLifetimePage, and(
      eq(spenderLifetimePage.platformAccountId, pageSubscriptions.platformAccountId),
      eq(spenderLifetimePage.fanId, pageSubscriptions.fanId),
    ))
    .where(clauses)
    .orderBy(asc(pageSubscriptions.endsAt), asc(pageSubscriptions.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: rows[0]?.total ?? 0,
    items: rows.map(({ total: _total, ...item }) => item),
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

export async function listSubscriberTotalsForPages(
  db: Database,
  input: {
    pageIds: number[];
    fromBusinessDate?: string | null;
    toBusinessDate?: string | null;
  },
) {
  if (input.pageIds.length === 0) {
    return [];
  }

  const clauses = [inArray(dailySubscribers.platformAccountId, input.pageIds)];
  if (input.fromBusinessDate) {
    clauses.push(gte(dailySubscribers.businessDate, input.fromBusinessDate));
  }
  if (input.toBusinessDate) {
    clauses.push(lt(dailySubscribers.businessDate, input.toBusinessDate));
  }

  return db.select({
    pageId: dailySubscribers.platformAccountId,
    newSubscribers: sql<number>`coalesce(sum(${dailySubscribers.newSubscribers}), 0)::int`,
  }).from(dailySubscribers)
    .where(and(...clauses))
    .groupBy(dailySubscribers.platformAccountId);
}

export async function listFollowerTotalsForPages(
  db: Database,
  input: {
    pageIds: number[];
    fromBusinessDate?: string | null;
    toBusinessDate?: string | null;
  },
) {
  if (input.pageIds.length === 0) return [];
  const clauses = [inArray(dailyFollowers.platformAccountId, input.pageIds)];
  if (input.fromBusinessDate) clauses.push(gte(dailyFollowers.businessDate, input.fromBusinessDate));
  if (input.toBusinessDate) clauses.push(lt(dailyFollowers.businessDate, input.toBusinessDate));
  return db.select({
    pageId: dailyFollowers.platformAccountId,
    newFollowers: sql<number>`coalesce(sum(${dailyFollowers.newFollowers}), 0)::int`,
  }).from(dailyFollowers)
    .where(and(...clauses))
    .groupBy(dailyFollowers.platformAccountId);
}

export async function listFollowersForPage(
  db: Database,
  input: {
    pageId: number;
    limit: number;
    offset: number;
    query?: string;
    followedWithinHours?: number;
    subscriber?: boolean;
    dmStatus?: "none" | "has_dm";
    activeWithinMinutes?: number;
  },
) {
  const clauses = [
    sql`${pageFollows.platformAccountId} = ${input.pageId}`,
    sql`${pageFollows.isActive} = true`,
    sql`${fans.deletedDetectedAt} is null`,
  ];

  if (input.query) {
    const pattern = buildContainsSearchPattern(input.query);
    if (pattern) {
      clauses.push(or(
        ilikeEscaped(fans.platformUserId, pattern),
        pageAliasMatchSql({
          fanId: fans.id,
          platformAccountId: pageFollows.platformAccountId,
          pattern,
        }),
        pageAliasHistoryMatchSql({
          fanId: fans.id,
          platformAccountId: pageFollows.platformAccountId,
          pattern,
        }),
        ilikeEscaped(sql`coalesce(${fans.username}, '')`, pattern),
        ilikeEscaped(sql`coalesce(${fans.displayName}, '')`, pattern),
        sql`exists (
          select 1
          from ${fanUsernameAliases} fua
          where fua.fan_id = ${fans.id}
            and fua.username ilike ${pattern} escape '\\'
        )`,
      )!);
    }
  }

  if (input.followedWithinHours != null) {
    const cutoff = new Date(Date.now() - input.followedWithinHours * 60 * 60 * 1000);
    clauses.push(sql`${pageFollows.followedAt} >= ${cutoff}`);
  }

  if (input.subscriber != null) {
    clauses.push(sql`${fanPages.isSubscriber} = ${input.subscriber}`);
  }

  if (input.dmStatus === "none") {
    clauses.push(sql`dm.platform_conversation_id is null`);
  } else if (input.dmStatus === "has_dm") {
    clauses.push(sql`dm.platform_conversation_id is not null`);
  }

  if (input.activeWithinMinutes != null) {
    const cutoff = new Date(Date.now() - input.activeWithinMinutes * 60 * 1000);
    clauses.push(sql`${fanPages.externalPresenceAt} >= ${cutoff}`);
  }

  const activeNowCutoff = new Date(Date.now() - 30 * 60 * 1000);
  const recentlyActiveCutoff = new Date(Date.now() - 120 * 60 * 1000);
  const whereClause = sql.join(clauses, sql` and `);
  const rows = await db.execute<{
    total: number;
    platformUserId: string;
    pageAlias: string | null;
    username: string | null;
    displayName: string | null;
    followedAt: Date;
    isSubscriber: boolean;
    subscriberSince: Date | null;
    subscriptionExpiresAt: Date | null;
    autoRenew: boolean | null;
    autoRenewOffDetectedAt: Date | null;
    totalCreatorNetAmountMills: bigint;
    lastTransactionAt: Date | null;
    platformConversationId: string | null;
    unreadCount: number | null;
    lastMessageAt: Date | null;
    lastFanMessageAt: Date | null;
    lastModelMessageAt: Date | null;
    lastMessagePreview: string | null;
    presenceStatus: "active_now" | "recently_active" | "offline";
    externalPresenceAt: Date | null;
    externalPresenceObservedAt: Date | null;
  }>(sql`
    select count(*) over()::int as "total",
           ${fans.platformUserId} as "platformUserId",
           ${fanPages.pageAlias} as "pageAlias",
           ${fans.username} as "username",
           ${fans.displayName} as "displayName",
           ${pageFollows.followedAt} as "followedAt",
           ${fanPages.isSubscriber} as "isSubscriber",
           ${fanPages.subscriberSince} as "subscriberSince",
           ${fanPages.subscriptionExpiresAt} as "subscriptionExpiresAt",
           ${fanPages.autoRenew} as "autoRenew",
           ${fanPages.autoRenewOffDetectedAt} as "autoRenewOffDetectedAt",
           coalesce(${spenderLifetimePage.creatorNetAmountMills}, 0)::bigint as "totalCreatorNetAmountMills",
           ${spenderLifetimePage.lastTransactionAt} as "lastTransactionAt",
           dm.platform_conversation_id as "platformConversationId",
           dm.unread_count as "unreadCount",
           dm.last_message_at as "lastMessageAt",
           dm.last_fan_message_at as "lastFanMessageAt",
           dm.last_model_message_at as "lastModelMessageAt",
           dm.last_message_preview as "lastMessagePreview",
           case
             when ${fanPages.externalPresenceAt} >= ${activeNowCutoff} then 'active_now'
             when ${fanPages.externalPresenceAt} >= ${recentlyActiveCutoff} then 'recently_active'
             else 'offline'
           end as "presenceStatus",
           ${fanPages.externalPresenceAt} as "externalPresenceAt",
           ${fanPages.externalPresenceObservedAt} as "externalPresenceObservedAt"
    from ${pageFollows}
    inner join ${fans} on ${fans.id} = ${pageFollows.fanId}
    inner join ${fanPages}
      on ${fanPages.platformAccountId} = ${pageFollows.platformAccountId}
     and ${fanPages.fanId} = ${pageFollows.fanId}
    left join ${spenderLifetimePage}
      on ${spenderLifetimePage.platformAccountId} = ${pageFollows.platformAccountId}
     and ${spenderLifetimePage.fanId} = ${pageFollows.fanId}
    left join lateral (
      select c.platform_conversation_id,
             c.unread_count,
             c.last_message_at,
             c.last_fan_message_at,
             c.last_model_message_at,
             c.last_message_preview
      from ${pageDmConversations} c
      where c.platform_account_id = ${pageFollows.platformAccountId}
        and c.fan_id = ${pageFollows.fanId}
        and c.is_visible = true
      order by c.last_message_at desc nulls last, c.id desc
      limit 1
    ) dm on true
    where ${whereClause}
    order by ${pageFollows.followedAt} desc, ${pageFollows.id} desc
    limit ${input.limit}
    offset ${input.offset}
  `);

  return {
    total: rows.rows[0]?.total ?? 0,
    items: rows.rows.map(({ total: _total, ...item }) => item),
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
  const clauses = [
    eq(fanPages.platformAccountId, input.pageId),
    sql`${fans.deletedDetectedAt} is null`,
  ];
  if (input.query) {
    const pattern = buildContainsSearchPattern(input.query);
    if (pattern) {
      clauses.push(or(
        ilikeEscaped(fans.platformUserId, pattern),
        pageAliasMatchSql({
          fanId: fans.id,
          platformAccountId: fanPages.platformAccountId,
          pattern,
        }),
        pageAliasHistoryMatchSql({
          fanId: fans.id,
          platformAccountId: fanPages.platformAccountId,
          pattern,
        }),
        ilikeEscaped(sql`coalesce(${fans.username}, '')`, pattern),
        ilikeEscaped(sql`coalesce(${fans.displayName}, '')`, pattern),
        sql`exists (
          select 1
          from ${fanUsernameAliases} fua
          where fua.fan_id = ${fans.id}
            and fua.username ilike ${pattern} escape '\\'
        )`,
      )!);
    }
  }
  const rows = await db.select({
    total: sql<number>`count(*) over()::int`,
    platformUserId: fans.platformUserId,
    pageAlias: fanPages.pageAlias,
    username: fans.username,
    displayName: fans.displayName,
    totalCreatorNetMills: sql<bigint>`coalesce(${spenderLifetimePage.creatorNetAmountMills}, 0)::bigint`,
    currency: fanPages.currency,
    isFollower: fanPages.isFollower,
    followerSince: fanPages.followerSince,
    isSubscriber: fanPages.isSubscriber,
    subscriberSince: fanPages.subscriberSince,
    subscriptionExpiresAt: fanPages.subscriptionExpiresAt,
    autoRenew: fanPages.autoRenew,
    autoRenewOffDetectedAt: fanPages.autoRenewOffDetectedAt,
    lastTransactionAt: spenderLifetimePage.lastTransactionAt,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .leftJoin(spenderLifetimePage, and(
      eq(spenderLifetimePage.platformAccountId, fanPages.platformAccountId),
      eq(spenderLifetimePage.fanId, fanPages.fanId),
    ))
    .where(and(...clauses))
    .orderBy(
      desc(sql`coalesce(${spenderLifetimePage.creatorNetAmountMills}, 0)`),
      desc(spenderLifetimePage.lastTransactionAt),
      asc(fans.id),
    )
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: rows[0]?.total ?? 0,
    items: rows.map(({ total: _total, ...item }) => item),
  };
}

export async function listDeletedFansForPage(
  db: Database,
  input: {
    pageId: number;
    limit: number;
    offset: number;
  },
) {
  const rows = await db.select({
    total: sql<number>`count(*) over()::int`,
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
    pageAlias: fanPages.pageAlias,
    latestHistoricalUsername: sql<string | null>`(
      select fua.username
      from ${fanUsernameAliases} fua
      where fua.fan_id = ${fans.id}
      order by fua.last_seen_at desc, fua.username asc
      limit 1
    )`,
    latestHistoricalPageAlias: sql<string | null>`(
      select fpa.alias
      from ${fanPageAliases} fpa
      where fpa.platform_account_id = ${input.pageId}
        and fpa.fan_id = ${fans.id}
      order by fpa.last_seen_at desc, fpa.alias asc
      limit 1
    )`,
    deletedDetectedAt: fans.deletedDetectedAt,
    deletedLastDetectedAt: fans.deletedLastDetectedAt,
    lastSeenAt: fans.lastSeenAt,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .where(and(
      eq(fanPages.platformAccountId, input.pageId),
      sql`${fans.deletedDetectedAt} is not null`,
    ))
    .orderBy(desc(fans.deletedDetectedAt), asc(fans.platformUserId))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: rows[0]?.total ?? 0,
    items: rows.map(({ total: _total, ...item }) => item),
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
    pageAlias: fanPages.pageAlias,
    username: fans.username,
    displayName: fans.displayName,
    createdAtExternal: fans.createdAtExternal,
    pageId: pages.id,
    pageLabel: pages.label,
    modelSlug: models.slug,
    modelName: models.name,
    totalCreatorNetMills: sql<bigint>`coalesce(${spenderLifetimePage.creatorNetAmountMills}, 0)::bigint`,
    currency: fanPages.currency,
    isFollower: fanPages.isFollower,
    followerSince: fanPages.followerSince,
    isSubscriber: fanPages.isSubscriber,
    subscriberSince: fanPages.subscriberSince,
    subscriptionExpiresAt: fanPages.subscriptionExpiresAt,
    autoRenew: fanPages.autoRenew,
    autoRenewOffDetectedAt: fanPages.autoRenewOffDetectedAt,
    lastTransactionAt: spenderLifetimePage.lastTransactionAt,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .innerJoin(pages, eq(pages.id, fanPages.platformAccountId))
    .innerJoin(models, eq(models.id, pages.modelId))
    .leftJoin(spenderLifetimePage, and(
      eq(spenderLifetimePage.platformAccountId, fanPages.platformAccountId),
      eq(spenderLifetimePage.fanId, fanPages.fanId),
    ))
    .where(and(
      eq(fanPages.platformAccountId, pageId),
      eq(fans.platformUserId, platformUserId),
      sql`${fans.deletedDetectedAt} is null`,
    ));

  return row ?? null;
}

export async function listFanPageContexts(
  db: Database,
  fanId: number,
  pageIds?: number[],
) {
  const clauses = [
    eq(fanPages.fanId, fanId),
    sql`${fans.deletedDetectedAt} is null`,
  ];
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
    pageId: pages.id,
    pageLabel: pages.label,
    modelSlug: models.slug,
    modelName: models.name,
    totalCreatorNetMills: sql<bigint>`coalesce(${spenderLifetimePage.creatorNetAmountMills}, 0)::bigint`,
    currency: fanPages.currency,
    pageAlias: fanPages.pageAlias,
    isFollower: fanPages.isFollower,
    followerSince: fanPages.followerSince,
    isSubscriber: fanPages.isSubscriber,
    subscriberSince: fanPages.subscriberSince,
    subscriptionExpiresAt: fanPages.subscriptionExpiresAt,
    autoRenew: fanPages.autoRenew,
    autoRenewOffDetectedAt: fanPages.autoRenewOffDetectedAt,
    lastTransactionAt: spenderLifetimePage.lastTransactionAt,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .innerJoin(pages, eq(pages.id, fanPages.platformAccountId))
    .innerJoin(models, eq(models.id, pages.modelId))
    .leftJoin(spenderLifetimePage, and(
      eq(spenderLifetimePage.platformAccountId, fanPages.platformAccountId),
      eq(spenderLifetimePage.fanId, fanPages.fanId),
    ))
    .where(and(...clauses))
    .orderBy(models.slug, pages.label);
}

export async function countDistinctFansForPages(db: Database, pageIds: number[]) {
  if (pageIds.length === 0) {
    return 0;
  }

  const [row] = await db.select({
    count: sql<number>`count(distinct ${fanPages.fanId})::int`,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .where(and(
      inArray(fanPages.platformAccountId, pageIds),
      sql`${fans.deletedDetectedAt} is null`,
    ));

  return row?.count ?? 0;
}

export async function listRevenueDailyForPages(
  db: Database,
  input: {
    pageIds?: number[];
    fromBusinessDate?: string | null;
    toBusinessDate?: string | null;
    groupByType?: boolean;
  },
) {
  const clauses = buildRevenueRollupClauses({
    pageIds: input.pageIds,
    fromBusinessDate: input.fromBusinessDate,
    toBusinessDate: input.toBusinessDate,
  });

  if (!clauses) {
    return [];
  }

  if (input.groupByType) {
    return db.select({
      businessDate: dailyRevenue.businessDate,
      canonicalType: dailyRevenue.canonicalType,
      netAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.creatorNetAmountMills}), 0)::bigint`,
      transactionCount: sql<number>`coalesce(sum(${dailyRevenue.transactionCount}), 0)::int`,
    }).from(dailyRevenue)
      .where(and(...clauses))
      .groupBy(dailyRevenue.businessDate, dailyRevenue.canonicalType)
      .orderBy(dailyRevenue.businessDate, dailyRevenue.canonicalType);
  }

  return db.select({
    businessDate: dailyRevenue.businessDate,
    netAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.creatorNetAmountMills}), 0)::bigint`,
    transactionCount: sql<number>`coalesce(sum(${dailyRevenue.transactionCount}), 0)::int`,
  }).from(dailyRevenue)
    .where(and(...clauses))
    .groupBy(dailyRevenue.businessDate)
    .orderBy(dailyRevenue.businessDate);
}

export async function listTransactionsForScope(
  db: Database,
  input: {
    pageIds?: number[];
    pageLabel?: string;
    canonicalType?: string;
    transactionState?: string;
    sortBy?: "occurredAt" | "grossAmountMills" | "netAmountMills";
    sortDir?: "asc" | "desc";
    limit: number;
    offset: number;
  },
) {
  const clauses = buildTransactionScopeClauses({
    pageIds: input.pageIds,
    canonicalType: input.canonicalType,
    transactionState: input.transactionState,
    excludeExcludedTypes: false,
  });

  if (!clauses) {
    return { total: 0, items: [] };
  }

  if (input.pageLabel) {
    clauses.push(eq(pages.label, input.pageLabel));
  }

  const sortColumn = input.sortBy === "grossAmountMills"
    ? transactions.grossAmountMills
    : input.sortBy === "netAmountMills"
      ? transactions.creatorNetAmountMills
      : transactions.occurredAt;
  const sortFn = input.sortDir === "asc" ? asc : desc;

  const [countRow] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(transactions)
    .innerJoin(pages, eq(pages.id, transactions.platformAccountId))
    .where(and(...clauses));

  const items = await db.select({
    transactionId: transactions.transactionId,
    rawType: transactions.rawType,
    canonicalType: transactions.canonicalType,
    transactionState: transactions.transactionState,
    amountMills: transactions.grossAmountMills,
    destinationAmountMills: transactions.sourceDestinationAmountMills,
    netAmountMills: transactions.creatorNetAmountMills,
    walletId: transactions.walletId,
    correlationId: transactions.correlationId,
    correlationAccountId: transactions.correlationAccountId,
    occurredAt: transactions.occurredAt,
    sourceUpdatedAt: transactions.sourceUpdatedAt,
    fanPlatformUserId: sql<string | null>`case when ${fans.deletedDetectedAt} is null then ${fans.platformUserId} else null end`,
    fanUsername: sql<string | null>`case when ${fans.deletedDetectedAt} is null then ${fans.username} else null end`,
    fanDisplayName: sql<string | null>`case when ${fans.deletedDetectedAt} is null then ${fans.displayName} else null end`,
    pageLabel: pages.label,
    platform: pages.platform,
  }).from(transactions)
    .innerJoin(pages, eq(pages.id, transactions.platformAccountId))
    .leftJoin(fans, eq(fans.id, transactions.fanId))
    .where(and(...clauses))
    .orderBy(sortFn(sortColumn), desc(transactions.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    items,
  };
}

export async function listFanTransactionsOnPage(
  db: Database,
  input: {
    pageId: number;
    fanId: number;
    limit: number;
    offset: number;
  },
) {
  const clauses = and(
    eq(transactions.isActive, true),
    eq(transactions.platformAccountId, input.pageId),
    eq(transactions.fanId, input.fanId),
  );

  const [countRow] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(transactions).where(clauses);

  const items = await db.select({
    transactionId: transactions.transactionId,
    rawType: transactions.rawType,
    canonicalType: transactions.canonicalType,
    transactionState: transactions.transactionState,
    amountMills: transactions.grossAmountMills,
    destinationAmountMills: transactions.sourceDestinationAmountMills,
    netAmountMills: transactions.creatorNetAmountMills,
    occurredAt: transactions.occurredAt,
    sourceUpdatedAt: transactions.sourceUpdatedAt,
  }).from(transactions)
    .where(clauses)
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    items,
  };
}

export async function listFanTransactionsCrossPage(
  db: Database,
  input: {
    fanId: number;
    pageIds: number[];
    limit: number;
    offset: number;
  },
) {
  if (input.pageIds.length === 0) {
    return {
      total: 0,
      items: [],
    };
  }

  const clauses = [eq(transactions.isActive, true), eq(transactions.fanId, input.fanId)];
  clauses.push(inArray(transactions.platformAccountId, input.pageIds));

  const [countRow] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(transactions)
    .innerJoin(pages, eq(pages.id, transactions.platformAccountId))
    .where(and(...clauses));

  const items = await db.select({
    transactionId: transactions.transactionId,
    rawType: transactions.rawType,
    canonicalType: transactions.canonicalType,
    transactionState: transactions.transactionState,
    amountMills: transactions.grossAmountMills,
    destinationAmountMills: transactions.sourceDestinationAmountMills,
    netAmountMills: transactions.creatorNetAmountMills,
    occurredAt: transactions.occurredAt,
    sourceUpdatedAt: transactions.sourceUpdatedAt,
    pageLabel: pages.label,
    platform: pages.platform,
  }).from(transactions)
    .innerJoin(pages, eq(pages.id, transactions.platformAccountId))
    .where(and(...clauses))
    .orderBy(desc(transactions.occurredAt), desc(transactions.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    items,
  };
}

export async function getPlatformTotalSpendForFan(
  db: Database,
  input: {
    fanId: number;
    platform: "fansly" | "onlyfans";
    pageIds?: number[];
  },
) {
  const clauses = [
    eq(spenderLifetimePage.fanId, input.fanId),
    eq(pages.platform, input.platform),
  ];

  if (input.pageIds !== undefined) {
    if (input.pageIds.length === 0) {
      return 0n;
    }
    clauses.push(inArray(spenderLifetimePage.platformAccountId, input.pageIds));
  }

  const [row] = await db.select({
    total: sql<bigint>`coalesce(sum(${spenderLifetimePage.creatorNetAmountMills}), 0)::bigint`,
  }).from(spenderLifetimePage)
    .innerJoin(pages, eq(pages.id, spenderLifetimePage.platformAccountId))
    .where(and(...clauses));

  return row?.total ?? 0n;
}
