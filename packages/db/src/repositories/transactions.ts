import { and, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";

import {
  businessDateToUtcStart,
  getTransactionClassification,
  reportableTransactionTypes,
  resolveBusinessTimeZone,
  toBusinessDate,
  type TransactionType,
} from "@agency_hub_core/shared";
import type { Database } from "../client.ts";
import {
  dailyFollowers,
  dailyRevenue,
  dailySubscribers,
  platformAccounts,
  transactions,
} from "../schema.ts";

function transactionTypeListSql(transactionTypes: TransactionType[]) {
  return sql.join(
    transactionTypes.map((transactionType) => sql`${transactionType}::transaction_type`),
    sql`, `,
  );
}

export interface UpsertTransactionInput {
  platformAccountId: number;
  fanId?: number | null;
  transactionId: string;
  walletId?: string | null;
  accountId?: string | null;
  correlationId?: string | null;
  correlationAccountId?: string | null;
  rawType: string | number;
  canonicalType: TransactionType;
  transactionState: "pending" | "posted" | "unknown";
  destination?: number | null;
  rawStatus: string | number;
  grossAmountMills: bigint;
  sourceDestinationAmountMills: bigint;
  creatorNetAmountMills: bigint;
  rawDestinationTax?: number | null;
  newBalanceMills?: bigint | null;
  senderId?: string | null;
  receiverId?: string | null;
  occurredAt: Date;
  sourceUpdatedAt?: Date | null;
}

export async function upsertTransaction(db: Database, input: UpsertTransactionInput) {
  const insertValues = {
    fanId: input.fanId ?? null,
    walletId: input.walletId ?? null,
    accountId: input.accountId ?? null,
    correlationId: input.correlationId ?? null,
    correlationAccountId: input.correlationAccountId ?? null,
    rawType: String(input.rawType),
    canonicalType: input.canonicalType,
    transactionState: input.transactionState,
    destination: input.destination ?? null,
    rawStatus: String(input.rawStatus),
    grossAmountMills: input.grossAmountMills,
    sourceDestinationAmountMills: input.sourceDestinationAmountMills,
    creatorNetAmountMills: input.creatorNetAmountMills,
    rawDestinationTax: input.rawDestinationTax ?? null,
    newBalanceMills: input.newBalanceMills ?? null,
    senderId: input.senderId ?? null,
    receiverId: input.receiverId ?? null,
    occurredAt: input.occurredAt,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
    isActive: true,
    inactiveReason: null,
    inactivatedAt: null,
  };
  const updateSet = {
    ...insertValues,
    fanId: sql<number | null>`coalesce(excluded.fan_id, ${transactions.fanId})`,
  };

  const [transaction] = await db
    .insert(transactions)
    .values({
      platformAccountId: input.platformAccountId,
      transactionId: input.transactionId,
      ...insertValues,
    })
    .onConflictDoUpdate({
      target: [transactions.platformAccountId, transactions.transactionId],
      set: updateSet,
    })
    .returning();
  return transaction;
}

export async function rebuildRevenueRollups(
  db: Database,
  platformAccountId: number,
  from?: Date | null,
) {
  const reportableTransactionTypeSql = transactionTypeListSql(reportableTransactionTypes);
  await db.transaction(async (tx) => {
    const [account] = await tx.select({
      platform: platformAccounts.platform,
    }).from(platformAccounts)
      .where(eq(platformAccounts.id, platformAccountId));

    if (!account) {
      return;
    }

    const timeZone = resolveBusinessTimeZone(account.platform);
    const affectedFrom = from
      ? businessDateToUtcStart(toBusinessDate(from, timeZone), timeZone)
      : null;
    const fromClause = affectedFrom
      ? sql`and t.occurred_at >= ${affectedFrom}`
      : sql``;

    await tx.delete(dailyRevenue).where(affectedFrom
      ? and(
        eq(dailyRevenue.platformAccountId, platformAccountId),
        gte(dailyRevenue.businessDate, toBusinessDate(affectedFrom, timeZone)),
      )
      : eq(dailyRevenue.platformAccountId, platformAccountId));
    await tx.execute(sql`
      insert into revenue_daily (
        platform_account_id,
        business_date,
        canonical_type,
        transaction_state,
        transaction_count,
        gross_amount_mills,
        creator_net_amount_mills,
        updated_at
      )
      select t.platform_account_id,
             (
               timezone('UTC', t.occurred_at)::date
             ) as business_date,
             t.canonical_type,
             t.transaction_state,
             count(*)::int,
             coalesce(sum(t.gross_amount_mills), 0)::bigint,
             coalesce(sum(t.creator_net_amount_mills), 0)::bigint,
             now()
      from transactions t
      join pages pa on pa.id = t.platform_account_id
      where t.platform_account_id = ${platformAccountId}
        and t.is_active = true
        and t.canonical_type in (${reportableTransactionTypeSql})
        ${fromClause}
      group by 1, 2, 3, 4
      on conflict (
        platform_account_id,
        business_date,
        canonical_type,
        transaction_state
      ) do update set
        transaction_count = excluded.transaction_count,
        gross_amount_mills = excluded.gross_amount_mills,
        creator_net_amount_mills = excluded.creator_net_amount_mills,
        updated_at = excluded.updated_at
    `);
  });
}

export async function rebuildFollowerRollups(
  db: Database,
  platformAccountId: number,
  knownTotalFollowers: number | null,
) {
  await db.transaction(async (tx) => {
    await tx.delete(dailyFollowers).where(eq(dailyFollowers.platformAccountId, platformAccountId));
    await tx.execute(sql`
      insert into daily_followers (
        platform_account_id,
        business_date,
        new_followers,
        known_total_followers,
        updated_at
      )
      select pf.platform_account_id,
             ((pf.followed_at at time zone 'UTC')::date) as business_date,
             count(*)::int,
             case
               when ((pf.followed_at at time zone 'UTC')::date) =
                    ((now() at time zone 'UTC')::date)
                 then ${knownTotalFollowers}::integer
               else null::integer
             end,
             now()
      from page_follows pf
      where pf.platform_account_id = ${platformAccountId}
      group by 1, 2
      on conflict (
        platform_account_id,
        business_date
      ) do update set
        new_followers = excluded.new_followers,
        known_total_followers = excluded.known_total_followers,
        updated_at = excluded.updated_at
    `);
  });
}

export async function rebuildSubscriberRollups(db: Database, platformAccountId: number) {
  await db.transaction(async (tx) => {
    await tx.delete(dailySubscribers).where(eq(dailySubscribers.platformAccountId, platformAccountId));
    await tx.execute(sql`
      with date_series as (
        select generate_series(
          coalesce(
            (select min((source_created_at at time zone 'UTC')::date)
             from page_subscriptions
             where platform_account_id = ${platformAccountId}),
            (now() at time zone 'UTC')::date
          ),
          (now() at time zone 'UTC')::date,
          interval '1 day'
        )::date as business_date
      ),
      new_subscribers as (
        select ((source_created_at at time zone 'UTC')::date) as business_date,
               count(*)::int as new_subscribers
        from page_subscriptions
        where platform_account_id = ${platformAccountId}
        group by 1
      ),
      active_subscribers as (
        select ds.business_date,
               count(ps.id)::int as active_subscribers
        from date_series ds
        left join page_subscriptions ps
          on ps.platform_account_id = ${platformAccountId}
         and coalesce((ps.source_created_at at time zone 'UTC')::date, ds.business_date) <= ds.business_date
         and coalesce((ps.ends_at at time zone 'UTC')::date, ds.business_date) >= ds.business_date
        group by ds.business_date
      )
      insert into daily_subscribers (
        platform_account_id,
        business_date,
        new_subscribers,
        active_subscribers,
        updated_at
      )
      select ${platformAccountId},
             ds.business_date,
             coalesce(ns.new_subscribers, 0),
             coalesce(ac.active_subscribers, 0),
             now()
      from date_series ds
      left join new_subscribers ns on ns.business_date = ds.business_date
      left join active_subscribers ac on ac.business_date = ds.business_date
      on conflict (
        platform_account_id,
        business_date
      ) do update set
        new_subscribers = excluded.new_subscribers,
        active_subscribers = excluded.active_subscribers,
        updated_at = excluded.updated_at
    `);
  });
}

export async function getRevenueBreakdown(
  db: Database,
  platformAccountId: number,
  platform: "fansly" | "onlyfans",
  from: Date | null,
  to: Date | null,
) {
  const timeZone = resolveBusinessTimeZone(platform);
  const clauses = [
    eq(dailyRevenue.platformAccountId, platformAccountId),
    inArray(
      dailyRevenue.canonicalType,
      reportableTransactionTypes as Array<typeof dailyRevenue.$inferSelect.canonicalType>,
    ),
  ];

  if (from) {
    clauses.push(gte(dailyRevenue.businessDate, toBusinessDate(from, timeZone)));
  }
  if (to) {
    clauses.push(lt(dailyRevenue.businessDate, toBusinessDate(to, timeZone)));
  }

  const rows = await db
    .select({
      canonicalType: dailyRevenue.canonicalType,
      grossAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.grossAmountMills}), 0)::bigint`,
      creatorNetAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.creatorNetAmountMills}), 0)::bigint`,
    })
    .from(dailyRevenue)
    .where(and(...clauses))
    .groupBy(dailyRevenue.canonicalType);

  return rows.map((row) => ({
    ...row,
    netAmountMills: row.creatorNetAmountMills,
    bucket: getTransactionClassification(row.canonicalType).bucket,
  }));
}

export async function retireTransactionsMissingFromWindow(
  db: Database,
  input: {
    platformAccountId: number;
    from: Date;
    to: Date;
    cleanupMode: "keep_set" | "authoritative_empty";
    keepTransactionIds?: string[];
  },
) {
  const clauses = [
    eq(transactions.platformAccountId, input.platformAccountId),
    gte(transactions.occurredAt, input.from),
    lt(transactions.occurredAt, input.to),
    eq(transactions.isActive, true),
  ];

  if (input.cleanupMode === "keep_set") {
    const keepTransactionIds = input.keepTransactionIds ?? [];
    if (keepTransactionIds.length === 0) {
      return;
    }
    clauses.push(notInArray(transactions.transactionId, keepTransactionIds));
  }

  await db
    .update(transactions)
    .set({
      isActive: false,
      inactiveReason: "missing_from_sync_window",
      inactivatedAt: new Date(),
    })
    .where(and(...clauses));
}

export const deleteTransactionsMissingFromWindow = retireTransactionsMissingFromWindow;

export async function getOldestPendingTransactionAt(
  db: Database,
  platformAccountId: number,
) {
  const result = await db.execute(sql`
    select min(occurred_at) as oldest_pending_at
    from transactions
    where platform_account_id = ${platformAccountId}
      and is_active = true
      and transaction_state = 'pending'::transaction_state
  `);

  const value = result.rows[0]?.oldest_pending_at;
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value as string);
}
