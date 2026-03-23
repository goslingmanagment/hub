import { and, asc, desc, eq, gte, inArray, lt, or, sql } from "drizzle-orm";

import {
  businessDateToUtcStart,
  spenderAnalyticsTransactionTypes,
  toBusinessDate,
  type Platform,
  type TransactionType,
  UTC_TIME_ZONE,
} from "@agency_hub_core/shared";
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
import { buildContainsSearchPattern, ilikeEscaped } from "./search.ts";

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
  from?: Date | null,
) {
  const affectedFrom = from
    ? businessDateToUtcStart(toBusinessDate(from, UTC_TIME_ZONE), UTC_TIME_ZONE)
    : null;
  const fromClause = affectedFrom
    ? sql`and t.occurred_at >= ${affectedFrom}`
    : sql``;

  await db.delete(spenderDailyFacts).where(affectedFrom
    ? and(
      eq(spenderDailyFacts.platformAccountId, platformAccountId),
      gte(spenderDailyFacts.businessDate, toBusinessDate(affectedFrom, UTC_TIME_ZONE)),
    )
    : eq(spenderDailyFacts.platformAccountId, platformAccountId));
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
           (timezone('UTC', t.occurred_at)::date) as business_date,
           t.canonical_type,
           t.transaction_state,
           count(*)::int,
           coalesce(sum(t.gross_amount_mills), 0)::bigint,
           coalesce(sum(t.creator_net_amount_mills), 0)::bigint,
           max(t.occurred_at),
           now()
    from transactions t
    where t.platform_account_id = ${platformAccountId}
      and t.fan_id is not null
      and t.canonical_type in (${spenderTransactionTypeSql})
      ${fromClause}
    group by 1, 2, 3, 4, 5
  `);
}

export async function rebuildSpenderLifetimePage(
  db: Database,
  platformAccountId: number,
  from?: Date | null,
) {
  if (!from) {
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
    return;
  }

  const affectedFrom = businessDateToUtcStart(toBusinessDate(from, UTC_TIME_ZONE), UTC_TIME_ZONE);
  const affectedFanRows = await db.selectDistinct({
    fanId: transactions.fanId,
  }).from(transactions)
    .where(and(
      eq(transactions.platformAccountId, platformAccountId),
      gte(transactions.occurredAt, affectedFrom),
      sql`${transactions.fanId} is not null`,
    ));
  const affectedFanIds = affectedFanRows
    .map((row) => row.fanId)
    .filter((fanId): fanId is number => fanId !== null);

  if (affectedFanIds.length === 0) {
    return;
  }

  await db.delete(spenderLifetimePage).where(and(
    eq(spenderLifetimePage.platformAccountId, platformAccountId),
    inArray(spenderLifetimePage.fanId, affectedFanIds),
  ));
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
      and sdf.fan_id in (${sql.join(affectedFanIds.map((fanId) => sql`${fanId}`), sql`, `)})
    group by 1, 2
  `);

  await db.execute(sql`
    update fan_pages fp
    set total_creator_net_mills = coalesce((
          select slp.creator_net_amount_mills
          from spender_lifetime_page slp
          where slp.platform_account_id = fp.platform_account_id
            and slp.fan_id = fp.fan_id
        ), 0)::bigint
    where fp.platform_account_id = ${platformAccountId}
      and fp.fan_id in (${sql.join(affectedFanIds.map((fanId) => sql`${fanId}`), sql`, `)})
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
  from?: Date | null,
  rebuiltAt = new Date(),
) {
  await db.transaction(async (tx) => {
    const dbTx = tx as Database;
    await rebuildSpenderDailyFacts(dbTx, platformAccountId, from);
    await rebuildSpenderLifetimePage(dbTx, platformAccountId, from);
    if (!from) {
      await tx.execute(sql`
        update fan_pages fp
        set total_creator_net_mills = coalesce((
              select slp.creator_net_amount_mills
              from spender_lifetime_page slp
              where slp.platform_account_id = fp.platform_account_id
                and slp.fan_id = fp.fan_id
            ), 0)::bigint
        where fp.platform_account_id = ${platformAccountId}
      `);
    }
    await upsertSpenderProjectionWatermark(dbTx, platformAccountId, rebuiltAt);
  });
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

  if (!row?.asOf) {
    return null;
  }

  const asOfDate = row.asOf instanceof Date ? row.asOf : new Date(row.asOf as unknown as string);
  if (Number.isNaN(asOfDate.getTime()) || asOfDate.getTime() <= 0) {
    return null;
  }

  return asOfDate;
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

export async function getSpenderTypeBreakdown(
  db: Database,
  input: {
    fanId: number;
    pageIds: number[];
    fromBusinessDate?: string;
    toBusinessDateExclusive?: string;
  },
) {
  if (input.pageIds.length === 0) {
    return [] as Array<{
      canonicalType: TransactionType;
      grossAmountMills: bigint;
      creatorNetAmountMills: bigint;
      transactionCount: number;
    }>;
  }

  const clauses = [
    eq(spenderDailyFacts.fanId, input.fanId),
    inArray(spenderDailyFacts.platformAccountId, input.pageIds),
  ];

  if (input.fromBusinessDate) {
    clauses.push(gte(spenderDailyFacts.businessDate, input.fromBusinessDate));
  }
  if (input.toBusinessDateExclusive) {
    clauses.push(lt(spenderDailyFacts.businessDate, input.toBusinessDateExclusive));
  }

  const rows = await db.select({
    canonicalType: spenderDailyFacts.canonicalType,
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.creatorNetAmountMills}), 0)::bigint`,
    transactionCount: sql<number>`coalesce(sum(${spenderDailyFacts.transactionCount}), 0)::int`,
  }).from(spenderDailyFacts)
    .where(and(...clauses))
    .groupBy(spenderDailyFacts.canonicalType);

  return rows
    .filter((row) =>
      row.grossAmountMills !== 0n ||
      row.creatorNetAmountMills !== 0n ||
      row.transactionCount !== 0
    )
    .sort((left, right) => {
      if (left.grossAmountMills === right.grossAmountMills) {
        return left.canonicalType.localeCompare(right.canonicalType);
      }

      return left.grossAmountMills > right.grossAmountMills ? -1 : 1;
    });
}

export async function getSpenderTypeBreakdownBatch(
  db: Database,
  input: {
    fanIds: number[];
    pageIds: number[];
    fromBusinessDate?: string;
    toBusinessDateExclusive?: string;
  },
) {
  if (input.pageIds.length === 0 || input.fanIds.length === 0) {
    return [] as Array<{
      fanId: number;
      canonicalType: TransactionType;
      grossAmountMills: bigint;
      creatorNetAmountMills: bigint;
      transactionCount: number;
    }>;
  }

  const clauses = [
    inArray(spenderDailyFacts.fanId, input.fanIds),
    inArray(spenderDailyFacts.platformAccountId, input.pageIds),
  ];

  if (input.fromBusinessDate) {
    clauses.push(gte(spenderDailyFacts.businessDate, input.fromBusinessDate));
  }
  if (input.toBusinessDateExclusive) {
    clauses.push(lt(spenderDailyFacts.businessDate, input.toBusinessDateExclusive));
  }

  const rows = await db.select({
    fanId: spenderDailyFacts.fanId,
    canonicalType: spenderDailyFacts.canonicalType,
    grossAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.grossAmountMills}), 0)::bigint`,
    creatorNetAmountMills: sql<bigint>`coalesce(sum(${spenderDailyFacts.creatorNetAmountMills}), 0)::bigint`,
    transactionCount: sql<number>`coalesce(sum(${spenderDailyFacts.transactionCount}), 0)::int`,
  }).from(spenderDailyFacts)
    .where(and(...clauses))
    .groupBy(spenderDailyFacts.fanId, spenderDailyFacts.canonicalType);

  return rows.filter((row) =>
    row.grossAmountMills !== 0n ||
    row.creatorNetAmountMills !== 0n ||
    row.transactionCount !== 0
  );
}

function buildSpenderQueryClause(
  query: string | undefined,
  input: {
    platform: Platform;
  },
) {
  const pattern = buildContainsSearchPattern(query);
  if (!pattern) {
    return eq(fans.platform, input.platform);
  }

  const aliasMatchSql = sql`exists (
    select 1
    from fan_username_aliases fua
    where fua.fan_id = ${fans.id}
      and fua.username ilike ${pattern} escape '\\'
  )`;

  return and(
    eq(fans.platform, input.platform),
    or(
      ilikeEscaped(fans.platformUserId, pattern),
      ilikeEscaped(sql`coalesce(${fans.username}, '')`, pattern),
      ilikeEscaped(sql`coalesce(${fans.displayName}, '')`, pattern),
      aliasMatchSql,
    )!,
  )!;
}

async function resolvePagedTotal(
  input: {
    offset: number;
  },
  rows: Array<{ total: number }>,
  loadTotal: () => Promise<number>,
) {
  if (rows.length > 0) {
    return rows[0].total;
  }

  if (input.offset === 0) {
    return 0;
  }

  return loadTotal();
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
    const rows = await db.select({
      total: sql<number>`count(*) over()::int`,
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

    const total = await resolvePagedTotal(input, rows, async () => {
      const [countRow] = await db.select({
        total: sql<number>`count(*)::int`,
      }).from(lifetimeMetrics)
        .innerJoin(fans, eq(fans.id, lifetimeMetrics.fanId))
        .where(whereClause);

      return countRow?.total ?? 0;
    });

    return {
      total,
      items: rows.map(({ total: _total, ...item }) => item),
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
  const rows = await db.select({
    total: sql<number>`count(*) over()::int`,
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

  const total = await resolvePagedTotal(input, rows, async () => {
    const [countRow] = await db.select({
      total: sql<number>`count(*)::int`,
    }).from(currentMetrics)
      .innerJoin(fans, eq(fans.id, currentMetrics.fanId))
      .where(whereClause);

    return countRow?.total ?? 0;
  });

  return {
    total,
    items: rows.map(({ total: _total, ...item }) => item),
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

  const pattern = buildContainsSearchPattern(input.query);
  if (!pattern) {
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
  const aliasMatchSql = sql`(
    select fua.username
    from fan_username_aliases fua
    where fua.fan_id = ${fans.id}
      and fua.username ilike ${pattern} escape '\\'
    order by fua.last_seen_at desc, fua.username asc
    limit 1
  )`;

  const matchClauses = or(
    ilikeEscaped(fans.platformUserId, pattern),
    ilikeEscaped(sql`coalesce(${fans.username}, '')`, pattern),
    ilikeEscaped(sql`coalesce(${fans.displayName}, '')`, pattern),
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
        when ${fans.platformUserId} ilike ${pattern} escape '\\' then 'platformUserId'
        when coalesce(${fans.username}, '') ilike ${pattern} escape '\\' then 'username'
        when ${aliasMatchSql} is not null then 'alias'
        else 'displayName'
      end
    `,
    matchedValue: sql<string | null>`
      case
        when ${fans.platformUserId} ilike ${pattern} escape '\\' then ${fans.platformUserId}
        when coalesce(${fans.username}, '') ilike ${pattern} escape '\\' then ${fans.username}
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
  revenueClauses.push(inArray(
    dailyRevenue.canonicalType,
    spenderAnalyticsTransactionTypes as Array<typeof dailyRevenue.$inferSelect.canonicalType>,
  ));

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
  revenueClauses.push(inArray(
    dailyRevenue.canonicalType,
    spenderAnalyticsTransactionTypes as Array<typeof dailyRevenue.$inferSelect.canonicalType>,
  ));

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
