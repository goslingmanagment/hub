import { and, asc, desc, eq, gte, ilike, inArray, lt, or, sql } from "drizzle-orm";

import {
  spenderAnalyticsTransactionTypes,
  type Platform,
  type TransactionType,
} from "@fansly-connect/shared";
import type { Database } from "../client.ts";
import {
  dailyRevenue,
  fanPages,
  fanUsernameAliases,
  fans,
  models,
  platformAccounts,
  spenderDailyFacts,
  spenderLifetimePage,
  spenderProjectionWatermarks,
  transactions,
} from "../schema.ts";

function transactionTypeListSql(transactionTypes: TransactionType[]) {
  return sql.join(
    transactionTypes.map((transactionType) => sql`${transactionType}::transaction_type`),
    sql`, `,
  );
}

const spenderTransactionTypeSql = transactionTypeListSql(spenderAnalyticsTransactionTypes);

export async function rebuildSpenderDailyFacts(
  db: Database,
  platformAccountId: number,
) {
  await db.delete(spenderDailyFacts).where(eq(spenderDailyFacts.platformAccountId, platformAccountId));
  await db.execute(sql`
    insert into spender_daily_facts (
      platform_account_id,
      fan_id,
      business_date,
      canonical_type,
      transaction_state,
      transaction_count,
      gross_amount_mills,
      creator_net_amount_mills,
      last_transaction_at,
      updated_at
    )
    select t.platform_account_id,
           t.fan_id,
           (
             timezone(
               case
                 when pa.platform = 'onlyfans'::platform then 'UTC'
                 else 'Europe/Moscow'
               end,
               t.occurred_at
             )::date
           ) as business_date,
           t.canonical_type,
           t.transaction_state,
           count(*)::int,
           coalesce(sum(t.gross_amount_mills), 0)::bigint,
           coalesce(sum(t.creator_net_amount_mills), 0)::bigint,
           max(t.occurred_at),
           now()
    from transactions t
    join platform_accounts pa on pa.id = t.platform_account_id
    where t.platform_account_id = ${platformAccountId}
      and t.fan_id is not null
      and t.canonical_type in (${spenderTransactionTypeSql})
    group by 1, 2, 3, 4, 5
  `);
}

export async function rebuildSpenderLifetimePage(
  db: Database,
  platformAccountId: number,
) {
  await db.delete(spenderLifetimePage).where(eq(spenderLifetimePage.platformAccountId, platformAccountId));
  await db.execute(sql`
    insert into spender_lifetime_page (
      platform_account_id,
      fan_id,
      gross_amount_mills,
      creator_net_amount_mills,
      last_transaction_at,
      updated_at
    )
    select sdf.platform_account_id,
           sdf.fan_id,
           coalesce(sum(sdf.gross_amount_mills), 0)::bigint,
           coalesce(sum(sdf.creator_net_amount_mills), 0)::bigint,
           max(sdf.last_transaction_at),
           now()
    from spender_daily_facts sdf
    where sdf.platform_account_id = ${platformAccountId}
    group by 1, 2
  `);
}

export async function upsertSpenderProjectionWatermark(
  db: Database,
  platformAccountId: number,
  lastRebuiltAt = new Date(),
) {
  const [watermark] = await db
    .insert(spenderProjectionWatermarks)
    .values({
      platformAccountId,
      lastRebuiltAt,
      updatedAt: lastRebuiltAt,
    })
    .onConflictDoUpdate({
      target: spenderProjectionWatermarks.platformAccountId,
      set: {
        lastRebuiltAt,
        updatedAt: lastRebuiltAt,
      },
    })
    .returning();

  return watermark;
}

export async function rebuildSpenderProjections(
  db: Database,
  platformAccountId: number,
  rebuiltAt = new Date(),
) {
  await rebuildSpenderDailyFacts(db, platformAccountId);
  await rebuildSpenderLifetimePage(db, platformAccountId);
  await upsertSpenderProjectionWatermark(db, platformAccountId, rebuiltAt);
}

export async function upsertSpenderLifetimePage(
  db: Database,
  input: {
    platformAccountId: number;
    fanId: number;
    grossAmountMills: bigint;
    creatorNetAmountMills: bigint;
    lastTransactionAt?: Date | null;
  },
) {
  const [row] = await db
    .insert(spenderLifetimePage)
    .values({
      platformAccountId: input.platformAccountId,
      fanId: input.fanId,
      grossAmountMills: input.grossAmountMills,
      creatorNetAmountMills: input.creatorNetAmountMills,
      lastTransactionAt: input.lastTransactionAt ?? null,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [spenderLifetimePage.platformAccountId, spenderLifetimePage.fanId],
      set: {
        grossAmountMills: input.grossAmountMills,
        creatorNetAmountMills: input.creatorNetAmountMills,
        lastTransactionAt: input.lastTransactionAt ?? null,
        updatedAt: new Date(),
      },
    })
    .returning();

  return row;
}

export async function getScopedLifetimeTotalsForFan(
  db: Database,
  input: {
    fanId: number;
    platform: Platform;
    pageIds?: number[];
  },
) {
  const clauses = [
    eq(spenderLifetimePage.fanId, input.fanId),
    eq(platformAccounts.platform, input.platform),
  ];

  if (input.pageIds !== undefined) {
    if (input.pageIds.length === 0) {
      return {
        grossAmountMills: 0n,
        creatorNetAmountMills: 0n,
        lastTransactionAt: null,
      };
    }

    clauses.push(inArray(spenderLifetimePage.platformAccountId, input.pageIds));
  }

  const [row] = await db.select({
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderLifetimePage.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderLifetimePage.creatorNetAmountMills}), 0)::bigint`,
    lastTransactionAt: sql<Date | null>`max(${spenderLifetimePage.lastTransactionAt})`,
  }).from(spenderLifetimePage)
    .innerJoin(platformAccounts, eq(platformAccounts.id, spenderLifetimePage.platformAccountId))
    .where(and(...clauses));

  return {
    grossAmountMills: row?.grossAmountMills ?? 0n,
    creatorNetAmountMills: row?.creatorNetAmountMills ?? 0n,
    lastTransactionAt: row?.lastTransactionAt ?? null,
  };
}

export async function getSpenderProjectionAsOf(
  db: Database,
  input: {
    pageIds: number[];
    platform?: Platform;
  },
) {
  if (input.pageIds.length === 0) {
    return null;
  }

  const clauses = [inArray(spenderProjectionWatermarks.platformAccountId, input.pageIds)];
  if (input.platform) {
    clauses.push(eq(platformAccounts.platform, input.platform));
  }

  const [row] = await db.select({
    asOf: sql<Date | null>`min(${spenderProjectionWatermarks.lastRebuiltAt})`,
  }).from(spenderProjectionWatermarks)
    .innerJoin(platformAccounts, eq(platformAccounts.id, spenderProjectionWatermarks.platformAccountId))
    .where(and(...clauses));

  if (!row?.asOf || row.asOf.getTime() <= 0) {
    return null;
  }

  return row.asOf;
}

export async function listVisibleScopePages(
  db: Database,
  input: {
    platform: Platform;
    pageIds?: number[];
    modelSlug?: string;
  },
) {
  if (input.pageIds !== undefined && input.pageIds.length === 0) {
    return [];
  }

  const clauses = [eq(platformAccounts.platform, input.platform)];
  if (input.pageIds !== undefined) {
    clauses.push(inArray(platformAccounts.id, input.pageIds));
  }
  if (input.modelSlug) {
    clauses.push(eq(models.slug, input.modelSlug));
  }

  return db.select({
    id: platformAccounts.id,
    label: platformAccounts.label,
    platform: platformAccounts.platform,
    modelSlug: models.slug,
    modelName: models.name,
    username: platformAccounts.username,
    displayName: platformAccounts.displayName,
  }).from(platformAccounts)
    .innerJoin(models, eq(models.id, platformAccounts.modelId))
    .where(and(...clauses))
    .orderBy(models.slug, platformAccounts.label);
}

export async function findVisibleFanByIdentity(
  db: Database,
  input: {
    platform: Platform;
    platformUserId: string;
    pageIds: number[];
  },
) {
  if (input.pageIds.length === 0) {
    return null;
  }

  const [row] = await db.select({
    fanId: fans.id,
    platform: fans.platform,
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
    createdAtExternal: fans.createdAtExternal,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .where(and(
      eq(fans.platform, input.platform),
      eq(fans.platformUserId, input.platformUserId),
      inArray(fanPages.platformAccountId, input.pageIds),
    ))
    .limit(1);

  return row ?? null;
}

export interface SpenderWindowMetricRow {
  fanId: number;
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
}

export type SpenderSortBy =
  | "grossAmountMills"
  | "creatorNetAmountMills"
  | "postedGrossAmountMills"
  | "pendingGrossAmountMills"
  | "postedCreatorNetAmountMills"
  | "pendingCreatorNetAmountMills"
  | "lifetimeGrossAmountMills"
  | "lifetimeCreatorNetAmountMills"
  | "lastTransactionAt"
  | "platformUserId"
  | "username"
  | "displayName";

export interface RankedSpenderRow {
  fanId: number;
  platform: Platform;
  platformUserId: string;
  username: string | null;
  displayName: string | null;
  createdAtExternal: Date | null;
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
  lifetimeGrossAmountMills: bigint;
  lifetimeCreatorNetAmountMills: bigint;
}

export async function getSpenderWindowMetrics(
  db: Database,
  input: {
    pageIds: number[];
    fromBusinessDate: string;
    toBusinessDateExclusive: string;
    fanIds?: number[];
  },
) {
  if (input.pageIds.length === 0) {
    return [] as SpenderWindowMetricRow[];
  }

  const clauses = [
    inArray(spenderDailyFacts.platformAccountId, input.pageIds),
    gte(spenderDailyFacts.businessDate, input.fromBusinessDate),
    lt(spenderDailyFacts.businessDate, input.toBusinessDateExclusive),
  ];

  if (input.fanIds !== undefined) {
    if (input.fanIds.length === 0) {
      return [] as SpenderWindowMetricRow[];
    }
    clauses.push(inArray(spenderDailyFacts.fanId, input.fanIds));
  }

  return db.select({
    fanId: spenderDailyFacts.fanId,
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.creatorNetAmountMills}), 0)::bigint`,
    postedGrossAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'posted'::transaction_state then ${spenderDailyFacts.grossAmountMills} else 0 end), 0)::bigint`,
    pendingGrossAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'pending'::transaction_state then ${spenderDailyFacts.grossAmountMills} else 0 end), 0)::bigint`,
    unknownGrossAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'unknown'::transaction_state then ${spenderDailyFacts.grossAmountMills} else 0 end), 0)::bigint`,
    postedCreatorNetAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'posted'::transaction_state then ${spenderDailyFacts.creatorNetAmountMills} else 0 end), 0)::bigint`,
    pendingCreatorNetAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'pending'::transaction_state then ${spenderDailyFacts.creatorNetAmountMills} else 0 end), 0)::bigint`,
    unknownCreatorNetAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'unknown'::transaction_state then ${spenderDailyFacts.creatorNetAmountMills} else 0 end), 0)::bigint`,
    transactionCount: sql<number>`coalesce(sum(${spenderDailyFacts.transactionCount}), 0)::int`,
    lastTransactionAt: sql<Date | null>`max(${spenderDailyFacts.lastTransactionAt})`,
  }).from(spenderDailyFacts)
    .where(and(...clauses))
    .groupBy(spenderDailyFacts.fanId);
}

function buildSpenderQueryClause(
  query: string | undefined,
  input: {
    platform: Platform;
  },
) {
  if (!query) {
    return eq(fans.platform, input.platform);
  }

  const pattern = `%${query}%`;
  const aliasMatchSql = sql`exists (
    select 1
    from fan_username_aliases fua
    where fua.fan_id = ${fans.id}
      and fua.username ilike ${pattern}
  )`;

  return and(
    eq(fans.platform, input.platform),
    or(
      ilike(fans.platformUserId, pattern),
      ilike(sql`coalesce(${fans.username}, '')`, pattern),
      ilike(sql`coalesce(${fans.displayName}, '')`, pattern),
      aliasMatchSql,
    )!,
  )!;
}

export async function listRankedSpenders(
  db: Database,
  input: {
    platform: Platform;
    pageIds: number[];
    period: "window" | "lifetime";
    fromBusinessDate?: string;
    toBusinessDateExclusive?: string;
    query?: string;
    sortBy: SpenderSortBy;
    sortDir: "asc" | "desc";
    limit: number;
    offset: number;
  },
) {
  if (input.pageIds.length === 0) {
    return {
      total: 0,
      items: [] as RankedSpenderRow[],
    };
  }

  const lifetimeMetrics = db.select({
    fanId: spenderLifetimePage.fanId,
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderLifetimePage.grossAmountMills}), 0)::bigint`.as("lifetime_gross_amount_mills"),
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderLifetimePage.creatorNetAmountMills}), 0)::bigint`.as("lifetime_creator_net_amount_mills"),
    lastTransactionAt: sql<Date | null>`max(${spenderLifetimePage.lastTransactionAt})`.as("lifetime_last_transaction_at"),
  }).from(spenderLifetimePage)
    .where(inArray(spenderLifetimePage.platformAccountId, input.pageIds))
    .groupBy(spenderLifetimePage.fanId)
    .as("lifetime_metrics");

  if (input.period === "lifetime") {
    const whereClause = buildSpenderQueryClause(input.query, input);

    const sortFieldMap = {
      grossAmountMills: lifetimeMetrics.grossAmountMills,
      creatorNetAmountMills: lifetimeMetrics.creatorNetAmountMills,
      postedGrossAmountMills: lifetimeMetrics.grossAmountMills,
      pendingGrossAmountMills: lifetimeMetrics.grossAmountMills,
      postedCreatorNetAmountMills: lifetimeMetrics.creatorNetAmountMills,
      pendingCreatorNetAmountMills: lifetimeMetrics.creatorNetAmountMills,
      lifetimeGrossAmountMills: lifetimeMetrics.grossAmountMills,
      lifetimeCreatorNetAmountMills: lifetimeMetrics.creatorNetAmountMills,
      lastTransactionAt: lifetimeMetrics.lastTransactionAt,
      platformUserId: fans.platformUserId,
      username: fans.username,
      displayName: fans.displayName,
    } satisfies Record<SpenderSortBy, typeof lifetimeMetrics.grossAmountMills | typeof lifetimeMetrics.lastTransactionAt | typeof fans.platformUserId | typeof fans.username | typeof fans.displayName>;

    const sortField = sortFieldMap[input.sortBy];
    const orderBy = input.sortDir === "asc" ? asc(sortField) : desc(sortField);
    const [countRow] = await db.select({
      total: sql<number>`count(*)::int`,
    }).from(lifetimeMetrics)
      .innerJoin(fans, eq(fans.id, lifetimeMetrics.fanId))
      .where(whereClause);

    const items = await db.select({
      fanId: fans.id,
      platform: fans.platform,
      platformUserId: fans.platformUserId,
      username: fans.username,
      displayName: fans.displayName,
      createdAtExternal: fans.createdAtExternal,
      grossAmountMills: sql<bigint>`0::bigint`,
      creatorNetAmountMills: sql<bigint>`0::bigint`,
      postedGrossAmountMills: sql<bigint>`0::bigint`,
      pendingGrossAmountMills: sql<bigint>`0::bigint`,
      unknownGrossAmountMills: sql<bigint>`0::bigint`,
      postedCreatorNetAmountMills: sql<bigint>`0::bigint`,
      pendingCreatorNetAmountMills: sql<bigint>`0::bigint`,
      unknownCreatorNetAmountMills: sql<bigint>`0::bigint`,
      transactionCount: sql<number>`0::int`,
      lastTransactionAt: lifetimeMetrics.lastTransactionAt,
      lifetimeGrossAmountMills: lifetimeMetrics.grossAmountMills,
      lifetimeCreatorNetAmountMills: lifetimeMetrics.creatorNetAmountMills,
    }).from(lifetimeMetrics)
      .innerJoin(fans, eq(fans.id, lifetimeMetrics.fanId))
      .where(whereClause)
      .orderBy(orderBy, asc(fans.platformUserId), asc(fans.id))
      .limit(input.limit)
      .offset(input.offset);

    return {
      total: countRow?.total ?? 0,
      items,
    };
  }

  if (!input.fromBusinessDate || !input.toBusinessDateExclusive) {
    throw new Error("Window spender ranking requires from/to business dates");
  }

  const currentMetrics = db.select({
    fanId: spenderDailyFacts.fanId,
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.grossAmountMills}), 0)::bigint`.as("gross_amount_mills"),
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.creatorNetAmountMills}), 0)::bigint`.as("creator_net_amount_mills"),
    postedGrossAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'posted'::transaction_state then ${spenderDailyFacts.grossAmountMills} else 0 end), 0)::bigint`.as("posted_gross_amount_mills"),
    pendingGrossAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'pending'::transaction_state then ${spenderDailyFacts.grossAmountMills} else 0 end), 0)::bigint`.as("pending_gross_amount_mills"),
    unknownGrossAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'unknown'::transaction_state then ${spenderDailyFacts.grossAmountMills} else 0 end), 0)::bigint`.as("unknown_gross_amount_mills"),
    postedCreatorNetAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'posted'::transaction_state then ${spenderDailyFacts.creatorNetAmountMills} else 0 end), 0)::bigint`.as("posted_creator_net_amount_mills"),
    pendingCreatorNetAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'pending'::transaction_state then ${spenderDailyFacts.creatorNetAmountMills} else 0 end), 0)::bigint`.as("pending_creator_net_amount_mills"),
    unknownCreatorNetAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'unknown'::transaction_state then ${spenderDailyFacts.creatorNetAmountMills} else 0 end), 0)::bigint`.as("unknown_creator_net_amount_mills"),
    transactionCount: sql<number>`coalesce(sum(${spenderDailyFacts.transactionCount}), 0)::int`.as("transaction_count"),
    lastTransactionAt: sql<Date | null>`max(${spenderDailyFacts.lastTransactionAt})`.as("last_transaction_at"),
  }).from(spenderDailyFacts)
    .where(and(
      inArray(spenderDailyFacts.platformAccountId, input.pageIds),
      gte(spenderDailyFacts.businessDate, input.fromBusinessDate),
      lt(spenderDailyFacts.businessDate, input.toBusinessDateExclusive),
    ))
    .groupBy(spenderDailyFacts.fanId)
    .as("current_metrics");

  const whereClause = buildSpenderQueryClause(input.query, input);
  const sortFieldMap = {
    grossAmountMills: currentMetrics.grossAmountMills,
    creatorNetAmountMills: currentMetrics.creatorNetAmountMills,
    postedGrossAmountMills: currentMetrics.postedGrossAmountMills,
    pendingGrossAmountMills: currentMetrics.pendingGrossAmountMills,
    postedCreatorNetAmountMills: currentMetrics.postedCreatorNetAmountMills,
    pendingCreatorNetAmountMills: currentMetrics.pendingCreatorNetAmountMills,
    lifetimeGrossAmountMills: lifetimeMetrics.grossAmountMills,
    lifetimeCreatorNetAmountMills: lifetimeMetrics.creatorNetAmountMills,
    lastTransactionAt: currentMetrics.lastTransactionAt,
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
  } satisfies Record<SpenderSortBy, typeof currentMetrics.grossAmountMills | typeof currentMetrics.lastTransactionAt | typeof lifetimeMetrics.grossAmountMills | typeof lifetimeMetrics.creatorNetAmountMills | typeof fans.platformUserId | typeof fans.username | typeof fans.displayName>;

  const sortField = sortFieldMap[input.sortBy];
  const orderBy = input.sortDir === "asc" ? asc(sortField) : desc(sortField);
  const [countRow] = await db.select({
    total: sql<number>`count(*)::int`,
  }).from(currentMetrics)
    .innerJoin(fans, eq(fans.id, currentMetrics.fanId))
    .leftJoin(lifetimeMetrics, eq(lifetimeMetrics.fanId, currentMetrics.fanId))
    .where(whereClause);

  const items = await db.select({
    fanId: fans.id,
    platform: fans.platform,
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
    createdAtExternal: fans.createdAtExternal,
    grossAmountMills: currentMetrics.grossAmountMills,
    creatorNetAmountMills: currentMetrics.creatorNetAmountMills,
    postedGrossAmountMills: currentMetrics.postedGrossAmountMills,
    pendingGrossAmountMills: currentMetrics.pendingGrossAmountMills,
    unknownGrossAmountMills: currentMetrics.unknownGrossAmountMills,
    postedCreatorNetAmountMills: currentMetrics.postedCreatorNetAmountMills,
    pendingCreatorNetAmountMills: currentMetrics.pendingCreatorNetAmountMills,
      unknownCreatorNetAmountMills: currentMetrics.unknownCreatorNetAmountMills,
      transactionCount: currentMetrics.transactionCount,
      lastTransactionAt: currentMetrics.lastTransactionAt,
      lifetimeGrossAmountMills: sql<bigint>`coalesce(${lifetimeMetrics.grossAmountMills}, 0)::bigint`.as("lifetime_gross_amount_mills"),
      lifetimeCreatorNetAmountMills: sql<bigint>`coalesce(${lifetimeMetrics.creatorNetAmountMills}, 0)::bigint`.as("lifetime_creator_net_amount_mills"),
    }).from(currentMetrics)
    .innerJoin(fans, eq(fans.id, currentMetrics.fanId))
    .leftJoin(lifetimeMetrics, eq(lifetimeMetrics.fanId, currentMetrics.fanId))
    .where(whereClause)
    .orderBy(orderBy, asc(fans.platformUserId), asc(fans.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    items,
  };
}

export async function getSpenderLifetimeMetrics(
  db: Database,
  input: {
    pageIds: number[];
    fanIds?: number[];
  },
) {
  if (input.pageIds.length === 0) {
    return [];
  }

  const clauses = [inArray(spenderLifetimePage.platformAccountId, input.pageIds)];
  if (input.fanIds !== undefined) {
    if (input.fanIds.length === 0) {
      return [];
    }
    clauses.push(inArray(spenderLifetimePage.fanId, input.fanIds));
  }

  return db.select({
    fanId: spenderLifetimePage.fanId,
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderLifetimePage.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderLifetimePage.creatorNetAmountMills}), 0)::bigint`,
    lastTransactionAt: sql<Date | null>`max(${spenderLifetimePage.lastTransactionAt})`,
  }).from(spenderLifetimePage)
    .where(and(...clauses))
    .groupBy(spenderLifetimePage.fanId);
}

export async function findVisibleFansByPlatformUserIds(
  db: Database,
  input: {
    platform: Platform;
    platformUserIds: string[];
    pageIds: number[];
  },
) {
  if (input.platformUserIds.length === 0 || input.pageIds.length === 0) {
    return [];
  }

  return db.select({
    fanId: fans.id,
    platform: fans.platform,
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
    createdAtExternal: fans.createdAtExternal,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .where(and(
      eq(fans.platform, input.platform),
      inArray(fans.platformUserId, input.platformUserIds),
      inArray(fanPages.platformAccountId, input.pageIds),
    ))
    .groupBy(
      fans.id,
      fans.platform,
      fans.platformUserId,
      fans.username,
      fans.displayName,
      fans.createdAtExternal,
    )
    .orderBy(asc(fans.platformUserId), asc(fans.id));
}

export async function getEarliestSpenderBusinessDateForFan(
  db: Database,
  input: {
    fanId: number;
    pageIds: number[];
  },
) {
  if (input.pageIds.length === 0) {
    return null;
  }

  const [row] = await db.select({
    businessDate: sql<string | null>`min(${spenderDailyFacts.businessDate})`,
  }).from(spenderDailyFacts)
    .where(and(
      eq(spenderDailyFacts.fanId, input.fanId),
      inArray(spenderDailyFacts.platformAccountId, input.pageIds),
    ));

  return row?.businessDate ?? null;
}

export async function getSpenderDailySeriesRows(
  db: Database,
  input: {
    fanId: number;
    pageIds: number[];
    fromBusinessDate: string;
    toBusinessDateExclusive: string;
  },
) {
  if (input.pageIds.length === 0) {
    return [] as Array<{
      businessDate: string;
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
    }>;
  }

  return db.select({
    businessDate: spenderDailyFacts.businessDate,
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.creatorNetAmountMills}), 0)::bigint`,
    postedGrossAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'posted'::transaction_state then ${spenderDailyFacts.grossAmountMills} else 0 end), 0)::bigint`,
    pendingGrossAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'pending'::transaction_state then ${spenderDailyFacts.grossAmountMills} else 0 end), 0)::bigint`,
    unknownGrossAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'unknown'::transaction_state then ${spenderDailyFacts.grossAmountMills} else 0 end), 0)::bigint`,
    postedCreatorNetAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'posted'::transaction_state then ${spenderDailyFacts.creatorNetAmountMills} else 0 end), 0)::bigint`,
    pendingCreatorNetAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'pending'::transaction_state then ${spenderDailyFacts.creatorNetAmountMills} else 0 end), 0)::bigint`,
    unknownCreatorNetAmountMills: sql<bigint>`coalesce(sum(case when ${spenderDailyFacts.transactionState} = 'unknown'::transaction_state then ${spenderDailyFacts.creatorNetAmountMills} else 0 end), 0)::bigint`,
    transactionCount: sql<number>`coalesce(sum(${spenderDailyFacts.transactionCount}), 0)::int`,
    lastTransactionAt: sql<Date | null>`max(${spenderDailyFacts.lastTransactionAt})`,
  }).from(spenderDailyFacts)
    .where(and(
      eq(spenderDailyFacts.fanId, input.fanId),
      inArray(spenderDailyFacts.platformAccountId, input.pageIds),
      gte(spenderDailyFacts.businessDate, input.fromBusinessDate),
      lt(spenderDailyFacts.businessDate, input.toBusinessDateExclusive),
    ))
    .groupBy(spenderDailyFacts.businessDate)
    .orderBy(asc(spenderDailyFacts.businessDate));
}

export async function getVisibleFanPageMemberships(
  db: Database,
  input: {
    fanIds: number[];
    pageIds: number[];
  },
) {
  if (input.fanIds.length === 0 || input.pageIds.length === 0) {
    return [];
  }

  return db.select({
    fanId: fanPages.fanId,
    pageId: platformAccounts.id,
    pageLabel: platformAccounts.label,
    modelSlug: models.slug,
    modelName: models.name,
    platform: platformAccounts.platform,
    isFollower: fanPages.isFollower,
    followerSince: fanPages.followerSince,
    isSubscriber: fanPages.isSubscriber,
    subscriberSince: fanPages.subscriberSince,
    subscriptionExpiresAt: fanPages.subscriptionExpiresAt,
    autoRenew: fanPages.autoRenew,
    grossAmountMills: sql<bigint>`coalesce(${spenderLifetimePage.grossAmountMills}, 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(${spenderLifetimePage.creatorNetAmountMills}, 0)::bigint`,
    lastTransactionAt: spenderLifetimePage.lastTransactionAt,
  }).from(fanPages)
    .innerJoin(platformAccounts, eq(platformAccounts.id, fanPages.platformAccountId))
    .innerJoin(models, eq(models.id, platformAccounts.modelId))
    .leftJoin(spenderLifetimePage, and(
      eq(spenderLifetimePage.platformAccountId, fanPages.platformAccountId),
      eq(spenderLifetimePage.fanId, fanPages.fanId),
    ))
    .where(and(
      inArray(fanPages.fanId, input.fanIds),
      inArray(fanPages.platformAccountId, input.pageIds),
    ))
    .orderBy(models.slug, platformAccounts.label);
}

export async function searchFansInScope(
  db: Database,
  input: {
    platform: Platform;
    pageIds: number[];
    query: string;
    limit: number;
    offset: number;
  },
) {
  if (input.pageIds.length === 0) {
    return {
      total: 0,
      items: [] as Array<{
        fanId: number;
        platform: Platform;
        platformUserId: string;
        username: string | null;
        displayName: string | null;
        createdAtExternal: Date | null;
        matchKind: "platformUserId" | "username" | "alias" | "displayName";
        matchedValue: string | null;
      }>,
    };
  }

  const pattern = `%${input.query}%`;
  const aliasMatchSql = sql`(
    select fua.username
    from fan_username_aliases fua
    where fua.fan_id = ${fans.id}
      and fua.username ilike ${pattern}
    order by fua.last_seen_at desc, fua.username asc
    limit 1
  )`;

  const matchClauses = or(
    ilike(fans.platformUserId, pattern),
    ilike(sql`coalesce(${fans.username}, '')`, pattern),
    ilike(sql`coalesce(${fans.displayName}, '')`, pattern),
    sql`${aliasMatchSql} is not null`,
  )!;

  const [countRow] = await db.select({
    total: sql<number>`count(distinct ${fans.id})::int`,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .where(and(
      eq(fans.platform, input.platform),
      inArray(fanPages.platformAccountId, input.pageIds),
      matchClauses,
    ));

  const items = await db.select({
    fanId: fans.id,
    platform: fans.platform,
    platformUserId: fans.platformUserId,
    username: fans.username,
    displayName: fans.displayName,
    createdAtExternal: fans.createdAtExternal,
    matchKind: sql<"platformUserId" | "username" | "alias" | "displayName">`
      case
        when ${fans.platformUserId} ilike ${pattern} then 'platformUserId'
        when coalesce(${fans.username}, '') ilike ${pattern} then 'username'
        when ${aliasMatchSql} is not null then 'alias'
        else 'displayName'
      end
    `,
    matchedValue: sql<string | null>`
      case
        when ${fans.platformUserId} ilike ${pattern} then ${fans.platformUserId}
        when coalesce(${fans.username}, '') ilike ${pattern} then ${fans.username}
        when ${aliasMatchSql} is not null then ${aliasMatchSql}
        else ${fans.displayName}
      end
    `,
  }).from(fanPages)
    .innerJoin(fans, eq(fans.id, fanPages.fanId))
    .where(and(
      eq(fans.platform, input.platform),
      inArray(fanPages.platformAccountId, input.pageIds),
      matchClauses,
    ))
    .groupBy(
      fans.id,
      fans.platform,
      fans.platformUserId,
      fans.username,
      fans.displayName,
      fans.createdAtExternal,
    )
    .orderBy(asc(fans.platformUserId), asc(fans.id))
    .limit(input.limit)
    .offset(input.offset);

  return {
    total: countRow?.total ?? 0,
    items,
  };
}

export async function getUnattributedRevenueForScope(
  db: Database,
  input: {
    pageIds: number[];
    fromBusinessDate?: string | null;
    toBusinessDateExclusive?: string | null;
  },
) {
  if (input.pageIds.length === 0) {
    return {
      grossAmountMills: 0n,
      creatorNetAmountMills: 0n,
    };
  }

  const revenueClauses = [inArray(dailyRevenue.platformAccountId, input.pageIds)];
  const attributedClauses = [inArray(spenderDailyFacts.platformAccountId, input.pageIds)];

  if (input.fromBusinessDate) {
    revenueClauses.push(gte(dailyRevenue.businessDate, input.fromBusinessDate));
    attributedClauses.push(gte(spenderDailyFacts.businessDate, input.fromBusinessDate));
  }
  if (input.toBusinessDateExclusive) {
    revenueClauses.push(lt(dailyRevenue.businessDate, input.toBusinessDateExclusive));
    attributedClauses.push(lt(spenderDailyFacts.businessDate, input.toBusinessDateExclusive));
  }

  const [revenueRow] = await db.select({
    grossAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.creatorNetAmountMills}), 0)::bigint`,
  }).from(dailyRevenue)
    .where(and(...revenueClauses));

  const [attributedRow] = await db.select({
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.creatorNetAmountMills}), 0)::bigint`,
  }).from(spenderDailyFacts)
    .where(and(...attributedClauses));

  return {
    grossAmountMills: (revenueRow?.grossAmountMills ?? 0n) - (attributedRow?.grossAmountMills ?? 0n),
    creatorNetAmountMills:
      (revenueRow?.creatorNetAmountMills ?? 0n) - (attributedRow?.creatorNetAmountMills ?? 0n),
  };
}

export async function getSpenderRevenueDiagnosticsForScope(
  db: Database,
  input: {
    pageIds: number[];
    fromBusinessDate?: string | null;
    toBusinessDateExclusive?: string | null;
  },
) {
  if (input.pageIds.length === 0) {
    return {
      totalGrossAmountMills: 0n,
      totalCreatorNetAmountMills: 0n,
      attributedGrossAmountMills: 0n,
      attributedCreatorNetAmountMills: 0n,
      unattributedGrossAmountMills: 0n,
      unattributedCreatorNetAmountMills: 0n,
    };
  }

  const revenueClauses = [inArray(dailyRevenue.platformAccountId, input.pageIds)];
  const attributedClauses = [inArray(spenderDailyFacts.platformAccountId, input.pageIds)];

  if (input.fromBusinessDate) {
    revenueClauses.push(gte(dailyRevenue.businessDate, input.fromBusinessDate));
    attributedClauses.push(gte(spenderDailyFacts.businessDate, input.fromBusinessDate));
  }
  if (input.toBusinessDateExclusive) {
    revenueClauses.push(lt(dailyRevenue.businessDate, input.toBusinessDateExclusive));
    attributedClauses.push(lt(spenderDailyFacts.businessDate, input.toBusinessDateExclusive));
  }

  const [revenueRow] = await db.select({
    grossAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.creatorNetAmountMills}), 0)::bigint`,
  }).from(dailyRevenue)
    .where(and(...revenueClauses));

  const [attributedRow] = await db.select({
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.creatorNetAmountMills}), 0)::bigint`,
  }).from(spenderDailyFacts)
    .where(and(...attributedClauses));

  const totalGrossAmountMills = revenueRow?.grossAmountMills ?? 0n;
  const totalCreatorNetAmountMills = revenueRow?.creatorNetAmountMills ?? 0n;
  const attributedGrossAmountMills = attributedRow?.grossAmountMills ?? 0n;
  const attributedCreatorNetAmountMills = attributedRow?.creatorNetAmountMills ?? 0n;

  return {
    totalGrossAmountMills,
    totalCreatorNetAmountMills,
    attributedGrossAmountMills,
    attributedCreatorNetAmountMills,
    unattributedGrossAmountMills: totalGrossAmountMills - attributedGrossAmountMills,
    unattributedCreatorNetAmountMills: totalCreatorNetAmountMills - attributedCreatorNetAmountMills,
  };
}
