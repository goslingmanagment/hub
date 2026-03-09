import { and, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";

import {
  getTransactionClassification,
  reportableTransactionTypes,
  toBusinessDate,
  type TransactionType,
} from "@fansly-connect/shared";
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
  amountMills: bigint;
  destinationAmountMills: bigint;
  netAmountMills: bigint;
  rawDestinationTax?: number | null;
  newBalanceMills?: bigint | null;
  senderId?: string | null;
  receiverId?: string | null;
  occurredAt: Date;
  sourceUpdatedAt?: Date | null;
}

export async function upsertTransaction(db: Database, input: UpsertTransactionInput) {
  const patch = {
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
    amountMills: input.amountMills,
    destinationAmountMills: input.destinationAmountMills,
    netAmountMills: input.netAmountMills,
    rawDestinationTax: input.rawDestinationTax ?? null,
    newBalanceMills: input.newBalanceMills ?? null,
    senderId: input.senderId ?? null,
    receiverId: input.receiverId ?? null,
    occurredAt: input.occurredAt,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
  };

  const [transaction] = await db
    .insert(transactions)
    .values({
      platformAccountId: input.platformAccountId,
      transactionId: input.transactionId,
      ...patch,
    })
    .onConflictDoUpdate({
      target: [transactions.platformAccountId, transactions.transactionId],
      set: patch,
    })
    .returning();
  return transaction;
}

export async function rebuildRevenueRollups(
  db: Database,
  platformAccountId: number,
  from?: Date | null,
) {
  const fromClause = from
    ? sql`and t.occurred_at >= ${from}`
    : sql``;
  const reportableTransactionTypeSql = transactionTypeListSql(reportableTransactionTypes);

  await db.transaction(async (tx) => {
    await tx.delete(dailyRevenue).where(eq(dailyRevenue.platformAccountId, platformAccountId));
    await tx.execute(sql`
      insert into daily_revenue (
        platform_account_id,
        business_date,
        canonical_type,
        transaction_state,
        transaction_count,
        net_amount_mills,
        updated_at
      )
      select t.platform_account_id,
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
             coalesce(sum(t.net_amount_mills), 0)::bigint,
             now()
      from transactions t
      join platform_accounts pa on pa.id = t.platform_account_id
      where t.platform_account_id = ${platformAccountId}
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
        net_amount_mills = excluded.net_amount_mills,
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
             ((pf.followed_at at time zone 'Europe/Moscow')::date) as business_date,
             count(*)::int,
             case
               when ((pf.followed_at at time zone 'Europe/Moscow')::date) =
                    ((now() at time zone 'Europe/Moscow')::date)
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
            (select min((source_created_at at time zone 'Europe/Moscow')::date)
             from page_subscriptions
             where platform_account_id = ${platformAccountId}),
            (now() at time zone 'Europe/Moscow')::date
          ),
          (now() at time zone 'Europe/Moscow')::date,
          interval '1 day'
        )::date as business_date
      ),
      new_subscribers as (
        select ((source_created_at at time zone 'Europe/Moscow')::date) as business_date,
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
         and coalesce((ps.source_created_at at time zone 'Europe/Moscow')::date, ds.business_date) <= ds.business_date
         and coalesce((ps.ends_at at time zone 'Europe/Moscow')::date, ds.business_date) >= ds.business_date
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
  from: Date | null,
  to: Date | null,
) {
  const clauses = [
    eq(dailyRevenue.platformAccountId, platformAccountId),
    inArray(
      dailyRevenue.canonicalType,
      reportableTransactionTypes as Array<typeof dailyRevenue.$inferSelect.canonicalType>,
    ),
  ];

  if (from) {
    clauses.push(gte(dailyRevenue.businessDate, toBusinessDate(from)));
  }
  if (to) {
    clauses.push(lt(dailyRevenue.businessDate, toBusinessDate(to)));
  }

  const rows = await db
    .select({
      canonicalType: dailyRevenue.canonicalType,
      netAmountMills: sql<bigint>`coalesce(sum(${dailyRevenue.netAmountMills}), 0)`,
    })
    .from(dailyRevenue)
    .where(and(...clauses))
    .groupBy(dailyRevenue.canonicalType);

  return rows.map((row) => ({
    ...row,
    bucket: getTransactionClassification(row.canonicalType).bucket,
  }));
}

export async function deleteTransactionsMissingFromWindow(
  db: Database,
  input: {
    platformAccountId: number;
    from: Date;
    to: Date;
    keepTransactionIds: string[];
  },
) {
  const clauses = [
    eq(transactions.platformAccountId, input.platformAccountId),
    gte(transactions.occurredAt, input.from),
    lt(transactions.occurredAt, input.to),
  ];

  if (input.keepTransactionIds.length > 0) {
    clauses.push(notInArray(transactions.transactionId, input.keepTransactionIds));
  }

  await db.delete(transactions).where(and(...clauses));
}

export async function getOldestPendingTransactionAt(
  db: Database,
  platformAccountId: number,
) {
  const result = await db.execute(sql`
    select min(occurred_at) as oldest_pending_at
    from transactions
    where platform_account_id = ${platformAccountId}
      and transaction_state = 'pending'::transaction_state
  `);

  const value = result.rows[0]?.oldest_pending_at;
  if (!value) {
    return null;
  }

  return value instanceof Date ? value : new Date(value as string);
}
