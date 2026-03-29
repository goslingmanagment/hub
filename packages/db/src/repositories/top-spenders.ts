import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import { pageTopSpenders } from "../schema.ts";

export interface UpsertPageTopSpenderInput {
  platformAccountId: number;
  correlationAccountId: string;
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
      correlationAccountId: input.correlationAccountId,
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
      target: [pageTopSpenders.platformAccountId, pageTopSpenders.correlationAccountId],
      set: {
        accountId: sql`excluded.account_id`,
        fanId: sql`excluded.fan_id`,
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
