import { and, eq, gte, inArray, isNotNull, lt, sql } from "drizzle-orm";

import { spenderAnalyticsTransactionTypes } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";
import { fans, pageTopSpenders, transactions } from "../schema.ts";

export interface UpsertPageTopSpenderInput {
  platformAccountId: number;
  sourceIdentityKey: string;
  correlationAccountId?: string | null;
  accountId?: string | null;
  fanId?: number | null;
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
  sourceWindowStartedAt: Date;
  sourceWindowEndedAt: Date;
  lastSyncedAt?: Date;
}

export async function upsertPageTopSpenders(
  db: Database,
  inputs: UpsertPageTopSpenderInput[],
) {
  if (inputs.length === 0) {
    return;
  }

  const now = new Date();
  await db
    .insert(pageTopSpenders)
    .values(inputs.map((input) => ({
      platformAccountId: input.platformAccountId,
      sourceIdentityKey: input.sourceIdentityKey,
      correlationAccountId: input.correlationAccountId ?? null,
      accountId: input.accountId ?? null,
      fanId: input.fanId ?? null,
      grossAmountMills: input.grossAmountMills,
      creatorNetAmountMills: input.creatorNetAmountMills,
      sourceWindowStartedAt: input.sourceWindowStartedAt,
      sourceWindowEndedAt: input.sourceWindowEndedAt,
      lastSyncedAt: input.lastSyncedAt ?? now,
      updatedAt: now,
    })))
    .onConflictDoUpdate({
      target: [pageTopSpenders.platformAccountId, pageTopSpenders.sourceIdentityKey],
      set: {
        correlationAccountId: sql`excluded.correlation_account_id`,
        accountId: sql`excluded.account_id`,
        fanId: sql`coalesce(excluded.fan_id, ${pageTopSpenders.fanId})`,
        grossAmountMills: sql`excluded.gross_amount_mills`,
        creatorNetAmountMills: sql`excluded.creator_net_amount_mills`,
        sourceWindowStartedAt: sql`excluded.source_window_started_at`,
        sourceWindowEndedAt: sql`excluded.source_window_ended_at`,
        lastSyncedAt: sql`excluded.last_synced_at`,
        updatedAt: now,
      },
    });
}

export async function deletePageTopSpenders(
  db: Database,
  platformAccountId: number,
) {
  await db.delete(pageTopSpenders).where(eq(pageTopSpenders.platformAccountId, platformAccountId));
}

export async function countPageTopSpenders(
  db: Database,
  platformAccountId: number,
) {
  const [row] = await db.select({
    count: sql<number>`count(*)::int`,
  }).from(pageTopSpenders)
    .where(eq(pageTopSpenders.platformAccountId, platformAccountId));

  return row?.count ?? 0;
}

export async function findPageTopSpenderByCorrelationAccountId(
  db: Database,
  input: {
    platformAccountId: number;
    correlationAccountId: string;
  },
) {
  return db.query.pageTopSpenders.findFirst({
    where: and(
      eq(pageTopSpenders.platformAccountId, input.platformAccountId),
      eq(pageTopSpenders.correlationAccountId, input.correlationAccountId),
    ),
  });
}

// Shared filter with the spenders v2 projections (rebuildSpenderDailyFacts):
// active spender-relevant transactions linked to a fan — keeps the computed
// rankings reconcilable with fan_spend_daily for the same window.
function spenderTransactionClauses(platformAccountId: number, from: Date, to: Date) {
  return and(
    eq(transactions.platformAccountId, platformAccountId),
    eq(transactions.isActive, true),
    isNotNull(transactions.fanId),
    inArray(
      transactions.canonicalType,
      spenderAnalyticsTransactionTypes as Array<typeof transactions.$inferSelect.canonicalType>,
    ),
    gte(transactions.occurredAt, from),
    lt(transactions.occurredAt, to),
  );
}

export interface TransactionTopSpenderRow {
  fanId: number;
  fanPlatformUserId: string;
  grossAmountMills: bigint;
  creatorNetAmountMills: bigint;
}

/**
 * Per-fan gross/net sums over a window, straight from the transactions table —
 * the data source for the computed OnlyFans top_spenders stream (D10).
 */
export async function aggregateTransactionTopSpenders(
  db: Database,
  input: { platformAccountId: number; from: Date; to: Date },
): Promise<TransactionTopSpenderRow[]> {
  const rows = await db
    .select({
      fanId: transactions.fanId,
      fanPlatformUserId: fans.platformUserId,
      grossAmountMills: sql<string>`coalesce(sum(${transactions.grossAmountMills}), 0)::bigint`,
      creatorNetAmountMills: sql<string>`coalesce(sum(${transactions.creatorNetAmountMills}), 0)::bigint`,
    })
    .from(transactions)
    .innerJoin(fans, eq(fans.id, transactions.fanId))
    .where(spenderTransactionClauses(input.platformAccountId, input.from, input.to))
    .groupBy(transactions.fanId, fans.platformUserId)
    .orderBy(sql`3 desc`);

  return rows.flatMap((row) => (row.fanId !== null
    ? [{
      fanId: row.fanId,
      fanPlatformUserId: row.fanPlatformUserId,
      grossAmountMills: BigInt(row.grossAmountMills),
      creatorNetAmountMills: BigInt(row.creatorNetAmountMills),
    }]
    : []));
}

/** Earliest spender-relevant transaction — the bootstrap window anchor. */
export async function getEarliestSpenderTransactionAt(
  db: Database,
  platformAccountId: number,
): Promise<Date | null> {
  const [row] = await db
    .select({ earliest: sql<Date | string | null>`min(${transactions.occurredAt})` })
    .from(transactions)
    .where(and(
      eq(transactions.platformAccountId, platformAccountId),
      eq(transactions.isActive, true),
      isNotNull(transactions.fanId),
      inArray(
        transactions.canonicalType,
        spenderAnalyticsTransactionTypes as Array<typeof transactions.$inferSelect.canonicalType>,
      ),
    ));

  if (!row || row.earliest === null) {
    return null;
  }
  const parsed = row.earliest instanceof Date ? row.earliest : new Date(row.earliest);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
