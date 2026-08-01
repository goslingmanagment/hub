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
  pages,
  transactions,
} from "../schema.ts";

function transactionTypeListSql(transactionTypes: TransactionType[]) {
  return sql.join(
    transactionTypes.map((transactionType) => sql`${transactionType}::transaction_type`),
    sql`, `,
  );
}

/** Stage 13 provenance values — mirrors the transactions_source_check CHECK. */
export type TransactionSource =
  | "onlymonster"
  | "ofapi:webhook"
  | "ofapi:rest"
  | "fansly:rest"
  | "harvest";

export interface UpsertTransactionInput {
  platformAccountId: number;
  /** Required: every caller declares which system wrote this row (Stage 13). */
  source: TransactionSource;
  sourceObservationId?: number | null;
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
  /** Stage 14 explicit fees: fill-only — a writer that omits them never erases
   *  values another writer stored (coalesce on conflict, like fanId). */
  platformFeeMills?: bigint | null;
  vatAmountMills?: bigint | null;
  taxAmountMills?: bigint | null;
  rawDestinationTax?: number | null;
  newBalanceMills?: bigint | null;
  senderId?: string | null;
  receiverId?: string | null;
  occurredAt: Date;
  sourceUpdatedAt?: Date | null;
  scanToken?: string | null;
  /** W7.3 (A21+B4): write this row deactivated with the given negation-guard
   *  reason. Set by the negation-guard wrapper only. */
  suppressAs?: "superseded_duplicate_negation" | "reversal_without_settled_original" | null;
}

/** W7.3 (Guard 0): suppression reasons the conflict-set must PRESERVE — any
 * webhook redelivery / REST backfill re-upsert would otherwise resurrect a
 * deactivated twin and silently undo the guards and the repair. Only the
 * explicit late-original fixup (reactivateSuppressedNegations) clears them.
 * `missing_from_sync_window` deliberately stays out: a re-appearing row IS
 * its designed reactivation path. */
const STICKY_INACTIVE_REASONS_SQL = sql.raw(
  "('superseded_duplicate_negation'::transaction_inactive_reason, 'reversal_without_settled_original'::transaction_inactive_reason)",
);

export async function upsertTransaction(db: Database, input: UpsertTransactionInput) {
  const insertValues = {
    source: input.source,
    sourceObservationId: input.sourceObservationId ?? null,
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
    platformFeeMills: input.platformFeeMills ?? null,
    vatAmountMills: input.vatAmountMills ?? null,
    taxAmountMills: input.taxAmountMills ?? null,
    rawDestinationTax: input.rawDestinationTax ?? null,
    newBalanceMills: input.newBalanceMills ?? null,
    senderId: input.senderId ?? null,
    receiverId: input.receiverId ?? null,
    occurredAt: input.occurredAt,
    sourceUpdatedAt: input.sourceUpdatedAt ?? null,
    scanToken: input.scanToken ?? null,
    isActive: input.suppressAs ? false : true,
    inactiveReason: input.suppressAs ?? null,
    inactivatedAt: input.suppressAs ? new Date() : null,
  };
  const updateSet = {
    ...insertValues,
    // W7.3 (Guard 0): sticky suppression survives every re-upsert.
    isActive: sql<boolean>`case
      when ${transactions.inactiveReason} in ${STICKY_INACTIVE_REASONS_SQL}
        then ${transactions.isActive}
      else excluded.is_active
    end`,
    inactiveReason: sql`case
      when ${transactions.inactiveReason} in ${STICKY_INACTIVE_REASONS_SQL}
        then ${transactions.inactiveReason}
      else excluded.inactive_reason
    end`,
    inactivatedAt: sql`case
      when ${transactions.inactiveReason} in ${STICKY_INACTIVE_REASONS_SQL}
        then ${transactions.inactivatedAt}
      else excluded.inactivated_at
    end`,
    fanId: sql<number | null>`coalesce(excluded.fan_id, ${transactions.fanId})`,
    platformFeeMills: sql<bigint | null>`coalesce(excluded.platform_fee_mills, ${transactions.platformFeeMills})`,
    vatAmountMills: sql<bigint | null>`coalesce(excluded.vat_amount_mills, ${transactions.vatAmountMills})`,
    taxAmountMills: sql<bigint | null>`coalesce(excluded.tax_amount_mills, ${transactions.taxAmountMills})`,
    // Provenance (Stage 13/14 posture): the observation link is fill-only —
    // a writer with no link never erases one — and REST backfill never
    // downgrades webhook provenance. Amounts/state above stay last-writer
    // (Audit B2: money truth converges, provenance is the audit trail).
    sourceObservationId: sql<number | null>`coalesce(excluded.source_observation_id, ${transactions.sourceObservationId})`,
    source: sql<string>`case
      when ${transactions.source} = 'ofapi:webhook' and excluded.source = 'ofapi:rest'
        then ${transactions.source}
      else excluded.source
    end`,
    scanToken: input.scanToken === undefined
      ? sql`${transactions.scanToken}`
      : (input.scanToken ?? null),
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

/** W7.3: point lookup for the negation guards (twin / settled-original). */
export async function getTransactionByTransactionId(
  db: Database,
  input: { platformAccountId: number; transactionId: string },
) {
  const [row] = await db.select({
    id: transactions.id,
    transactionId: transactions.transactionId,
    transactionState: transactions.transactionState,
    isActive: transactions.isActive,
    inactiveReason: transactions.inactiveReason,
    occurredAt: transactions.occurredAt,
    grossAmountMills: transactions.grossAmountMills,
  }).from(transactions)
    .where(and(
      eq(transactions.platformAccountId, input.platformAccountId),
      eq(transactions.transactionId, input.transactionId),
    ));
  return row ?? null;
}

/** W7.3 (A21 fixup — the ONLY reactivation path for guard-suppressed rows):
 * a settled positive original just landed; reactivate AT MOST ONE suppressed
 * orphan negative under its id (earliest-created wins — the canonical twin),
 * and re-mark any remaining suppressed sibling as a duplicate negation (its
 * truthful state now that an original AND an active negative both exist).
 * Returns the earliest reactivated occurred_at for rollup dirtying. */
export async function reactivateSuppressedNegations(
  db: Database,
  input: { platformAccountId: number; baseTransactionId: string },
): Promise<{ reactivatedFrom: Date | null }> {
  const negativeIds = [
    `${input.baseTransactionId}:reversal`,
    `${input.baseTransactionId}:chargeback`,
  ];
  const suppressed = await db.select({
    id: transactions.id,
    occurredAt: transactions.occurredAt,
  }).from(transactions)
    .where(and(
      eq(transactions.platformAccountId, input.platformAccountId),
      inArray(transactions.transactionId, negativeIds),
      eq(transactions.isActive, false),
      eq(transactions.inactiveReason, "reversal_without_settled_original"),
    ))
    .orderBy(transactions.id);
  if (suppressed.length === 0) {
    return { reactivatedFrom: null };
  }

  const [canonical, ...rest] = suppressed;
  await db.update(transactions)
    .set({ isActive: true, inactiveReason: null, inactivatedAt: null })
    .where(eq(transactions.id, canonical!.id));
  if (rest.length > 0) {
    await db.update(transactions)
      .set({ inactiveReason: "superseded_duplicate_negation" })
      .where(inArray(transactions.id, rest.map((row) => row.id)));
  }
  return { reactivatedFrom: canonical!.occurredAt };
}

/** W7.4 (A47): stale ACTIVE PENDING OFAPI rows — candidates for the
 * settle-or-expire reconciliation. */
export async function listStalePendingOfapiTransactions(
  db: Database,
  input: { olderThan: Date },
) {
  return db.select({
    id: transactions.id,
    platformAccountId: transactions.platformAccountId,
    transactionId: transactions.transactionId,
    occurredAt: transactions.occurredAt,
    creatorNetAmountMills: transactions.creatorNetAmountMills,
    pageLabel: pages.label,
  }).from(transactions)
    .innerJoin(pages, eq(pages.id, transactions.platformAccountId))
    .where(and(
      inArray(transactions.source, ["ofapi:webhook", "ofapi:rest"]),
      eq(transactions.transactionState, "pending"),
      eq(transactions.isActive, true),
      lt(transactions.occurredAt, input.olderThan),
    ))
    .orderBy(transactions.platformAccountId, transactions.occurredAt);
}

/** W7.4 (A47): expire the pendings a fresh REST rescan did NOT settle —
 * targeted by row id, re-checked still active+pending (never a blind sweep).
 * Same reason as the Fansly anchor: a re-appearing row reactivates normally. */
export async function retireStalePendingTransactionsById(
  db: Database,
  input: { platformAccountId: number; ids: number[] },
): Promise<number> {
  if (input.ids.length === 0) {
    return 0;
  }
  const retired = await db.update(transactions)
    .set({
      isActive: false,
      inactiveReason: "missing_from_sync_window",
      inactivatedAt: new Date(),
    })
    .where(and(
      eq(transactions.platformAccountId, input.platformAccountId),
      inArray(transactions.id, input.ids),
      eq(transactions.isActive, true),
      eq(transactions.transactionState, "pending"),
    ))
    .returning({ id: transactions.id });
  return retired.length;
}

/** W7.4: how many of these rows are STILL active+pending (post-reconcile
 * honesty check — nonzero after a write pass means something is re-asserting
 * pending, e.g. the pre-fix ingest resurrection loop). */
export async function countActivePendingTransactionsByIds(
  db: Database,
  ids: number[],
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const rows = await db.select({ id: transactions.id }).from(transactions)
    .where(and(
      inArray(transactions.id, ids),
      eq(transactions.isActive, true),
      eq(transactions.transactionState, "pending"),
    ));
  return rows.length;
}

/** W7.3 repair (E6 census): active negation anomalies — double-negative
 * pairs and orphan negatives — for the owner-gated repair CLI. */
export async function listActiveNegationAnomalies(db: Database) {
  const pairs = await db.execute<{
    platform_account_id: number;
    reversal_id: number;
    chargeback_id: number;
    base_transaction_id: string;
    reversal_occurred_at: Date;
    chargeback_occurred_at: Date;
  }>(sql`
    select r.platform_account_id,
           r.id as reversal_id, c.id as chargeback_id,
           regexp_replace(r.transaction_id, ':reversal$', '') as base_transaction_id,
           r.occurred_at as reversal_occurred_at, c.occurred_at as chargeback_occurred_at
    from transactions r
    join transactions c on c.platform_account_id = r.platform_account_id
     and c.transaction_id = regexp_replace(r.transaction_id, ':reversal$', '') || ':chargeback'
    where r.transaction_id like '%:reversal' and r.is_active and c.is_active
  `);
  const orphans = await db.execute<{
    id: number;
    platform_account_id: number;
    transaction_id: string;
    occurred_at: Date;
    gross_amount_mills: string;
  }>(sql`
    select t.id, t.platform_account_id, t.transaction_id, t.occurred_at, t.gross_amount_mills::text
    from transactions t
    left join transactions o on o.platform_account_id = t.platform_account_id
     and o.transaction_id = regexp_replace(t.transaction_id, ':(reversal|chargeback)$', '')
     and o.is_active and o.transaction_state = 'posted'
    where (t.transaction_id like '%:reversal' or t.transaction_id like '%:chargeback')
      and t.is_active and o.id is null
  `);
  return { pairs: pairs.rows, orphans: orphans.rows };
}

/** W7.3 repair: deactivate a specific anomaly row (never delete). */
export async function deactivateTransactionById(
  db: Database,
  input: {
    id: number;
    reason: "superseded_duplicate_negation" | "reversal_without_settled_original";
  },
): Promise<void> {
  await db.update(transactions)
    .set({ isActive: false, inactiveReason: input.reason, inactivatedAt: new Date() })
    .where(and(eq(transactions.id, input.id), eq(transactions.isActive, true)));
}

export async function markTransactionsScanToken(
  db: Database,
  input: {
    platformAccountId: number;
    transactionIds: string[];
    scanToken: string;
  },
) {
  if (input.transactionIds.length === 0) {
    return;
  }

  for (let index = 0; index < input.transactionIds.length; index += 1_000) {
    const batch = input.transactionIds.slice(index, index + 1_000);
    await db
      .update(transactions)
      .set({
        scanToken: input.scanToken,
      })
      .where(and(
        eq(transactions.platformAccountId, input.platformAccountId),
        inArray(transactions.transactionId, batch),
      ));
  }
}

export async function rebuildRevenueRollups(
  db: Database,
  platformAccountId: number,
  from?: Date | null,
) {
  const reportableTransactionTypeSql = transactionTypeListSql(reportableTransactionTypes);
  await db.transaction(async (tx) => {
    const [account] = await tx.select({
      platform: pages.platform,
    }).from(pages)
      .where(eq(pages.id, platformAccountId));

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

/**
 * Rebuilds the page's daily follower rollup from `page_follows`.
 *
 * `new_followers` is fully derived and is recomputed from scratch, as it
 * always was. `known_total_followers` is NOT derivable from `page_follows` —
 * the live sync only ever knows TODAY's total — so the rebuild must not
 * destroy a historical value it cannot recreate. It used to: the DELETE below
 * cleared every row and the INSERT re-created historical days with a NULL
 * total, which silently erased the per-day totals the Fansly replay backfills
 * from the `page.identity_observed` ledger (slice D). Now the rebuild
 * PRESERVES any total it did not produce, so the two writers agree instead of
 * fighting: this one owns today's value and the follower counts, the replay
 * owns the historical totals. Re-deriving from the ledger here was the
 * alternative and was rejected — it would put a `domain_events` scan on the
 * hot sync path for a value this function does not own.
 */
export async function rebuildFollowerRollups(
  db: Database,
  platformAccountId: number,
  knownTotalFollowers: number | null,
) {
  await db.transaction(async (tx) => {
    const preserved = await tx.execute<{ business_date: string; known_total_followers: number }>(sql`
      select business_date::text as business_date, known_total_followers
      from daily_followers
      where platform_account_id = ${platformAccountId}
        and known_total_followers is not null
        and business_date < (now() at time zone 'UTC')::date
    `);
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
    if (preserved.rows.length > 0) {
      // Restore only where the rebuild left a hole: today's value stays the
      // live one, and a day that no longer has any follows simply has no row
      // to restore into (absence already means "unknown").
      await tx.execute(sql`
        update daily_followers df
        set known_total_followers = x.known_total_followers,
            updated_at = now()
        from jsonb_to_recordset(${JSON.stringify(preserved.rows)}::jsonb) as x(
          business_date date, known_total_followers integer
        )
        where df.platform_account_id = ${platformAccountId}
          and df.business_date = x.business_date
          and df.known_total_followers is null
      `);
    }
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
        -- Historical dates must count subscriptions that were active THEN,
        -- not only rows still in the platform's current set: is_current=false
        -- means "retired by a later sweep", and gating on it made every past
        -- day's count decay as fans churned. For retired rows the effective
        -- end is least(ends_at, last_seen_at) — last_seen_at is the
        -- retirement stamp (deactivate sets it; retired rows are never
        -- touched again), which covers early cancellation (ends_at still in
        -- the future) and natural expiry (retirement lagging ends_at) alike.
        select ds.business_date,
               count(ps.id)::int as active_subscribers
        from date_series ds
        left join page_subscriptions ps
          on ps.platform_account_id = ${platformAccountId}
         and coalesce((ps.source_created_at at time zone 'UTC')::date, ds.business_date) <= ds.business_date
         and (case
                when ps.is_current
                  then coalesce((ps.ends_at at time zone 'UTC')::date, ds.business_date)
                else (least(ps.ends_at, ps.last_seen_at) at time zone 'UTC')::date
              end) >= ds.business_date
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
    cleanupMode: "keep_set" | "authoritative_empty" | "scan_token";
    keepTransactionIds?: string[];
    scanToken?: string;
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
  } else if (input.cleanupMode === "scan_token") {
    if (!input.scanToken) {
      throw new Error("scanToken is required for scan_token cleanup");
    }

    clauses.push(sql`${transactions.scanToken} is distinct from ${input.scanToken}`);
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

/**
 * Counts active in-window transactions, splitting the total from the subset
 * that a `scan_token` retire would deactivate (rows whose scanToken does not
 * match the current scan). Used as a defensive guard so a provider that
 * under-returns a window cannot mass-deactivate otherwise-valid rows.
 */
export async function countActiveInWindowTransactionsByScanToken(
  db: Database,
  input: {
    platformAccountId: number;
    from: Date;
    to: Date;
    scanToken: string;
  },
) {
  const baseClauses = [
    eq(transactions.platformAccountId, input.platformAccountId),
    gte(transactions.occurredAt, input.from),
    lt(transactions.occurredAt, input.to),
    eq(transactions.isActive, true),
  ];

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      staleScanToken:
        sql<number>`count(*) filter (where ${transactions.scanToken} is distinct from ${input.scanToken})::int`,
    })
    .from(transactions)
    .where(and(...baseClauses));

  return {
    total: row?.total ?? 0,
    staleScanToken: row?.staleScanToken ?? 0,
  };
}

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
