import { and, eq, sql } from "drizzle-orm";

import type { Database } from "../client.ts";
import {
  dmBroadcastGroups,
  dmBroadcastMessages,
  workboardV3JobState,
  workboardV3Touches,
} from "../schema.ts";

// Workboard v3 data access. Raw SQL in/out; the FSM and detectors (apps/runtime)
// own the semantics. See docs/workboard-v3-prd.md §8.
//
// node-postgres parses int8 (OID 20) as bigint, so id/mills columns from raw
// db.execute() arrive as bigint; drizzle-built queries return numbers (mode:
// "number"). Helpers below normalize at the boundary.

function toNumber(value: bigint | number | string | null | undefined): number {
  if (value == null) {
    return 0;
  }
  return typeof value === "number" ? value : Number(value);
}

// Raw db.execute() may return timestamptz values as strings.
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

// ─── Broadcast detector (M0.2) ──────────────────────────────────────────────

export async function getWb3BroadcastWatermark(
  db: Database,
  platformAccountId: number,
): Promise<Date | null> {
  const rows = await db
    .select({ scannedUntil: workboardV3JobState.broadcastScannedUntil })
    .from(workboardV3JobState)
    .where(eq(workboardV3JobState.platformAccountId, platformAccountId))
    .limit(1);
  return rows[0]?.scannedUntil ?? null;
}

export async function setWb3BroadcastWatermark(
  db: Database,
  input: { platformAccountId: number; scannedUntil: Date },
): Promise<void> {
  await db
    .insert(workboardV3JobState)
    .values({
      platformAccountId: input.platformAccountId,
      broadcastScannedUntil: input.scannedUntil,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [workboardV3JobState.platformAccountId],
      set: { broadcastScannedUntil: input.scannedUntil, updatedAt: new Date() },
    });
}

export type Wb3BroadcastScanWindow = {
  minCreatedAt: Date;
  maxCreatedAt: Date;
  maxSyncedAt: Date;
  newCount: number;
};

/** Bounds of model messages synced after the watermark (null = nothing new). */
export async function getWb3BroadcastScanWindow(
  db: Database,
  input: { platformAccountId: number; syncedAfter: Date | null },
): Promise<Wb3BroadcastScanWindow | null> {
  const result = await db.execute<{
    min_created_at: Date | null;
    max_created_at: Date | null;
    max_synced_at: Date | null;
    new_count: bigint;
  }>(sql`
    select
      min(created_at) as min_created_at,
      max(created_at) as max_created_at,
      max(synced_at) as max_synced_at,
      count(*) as new_count
    from page_dm_messages
    where platform_account_id = ${input.platformAccountId}
      and sender_role = 'model'
      -- Truncate to ms: the watermark round-trips through a JS Date, which
      -- would otherwise leave µs remainders matching "synced_at >" forever.
      and (${input.syncedAfter}::timestamptz is null
        or date_trunc('milliseconds', synced_at) > ${input.syncedAfter})
  `);
  const row = result.rows[0];
  if (!row || !row.min_created_at || !row.max_created_at || !row.max_synced_at) {
    return null;
  }
  return {
    minCreatedAt: toDate(row.min_created_at),
    maxCreatedAt: toDate(row.max_created_at),
    maxSyncedAt: toDate(row.max_synced_at),
    newCount: toNumber(row.new_count),
  };
}

export type Wb3ModelMessageRow = {
  id: number;
  conversationId: number;
  fanId: number | null;
  createdAt: Date;
  content: string;
};

/** Model messages in a created_at range, with the thread's fan (for touch credit). */
export async function listWb3ModelMessagesForScan(
  db: Database,
  input: { platformAccountId: number; from: Date; to: Date },
): Promise<Wb3ModelMessageRow[]> {
  const result = await db.execute<{
    id: bigint;
    conversation_id: bigint;
    fan_id: bigint | null;
    created_at: Date;
    content: string;
  }>(sql`
    select m.id, m.conversation_id, t.fan_id, m.created_at, m.content
    from page_dm_messages m
    join page_dm_threads t on t.id = m.conversation_id
    where m.platform_account_id = ${input.platformAccountId}
      and m.sender_role = 'model'
      and m.created_at >= ${input.from}
      and m.created_at <= ${input.to}
    order by m.created_at asc, m.id asc
  `);
  return result.rows.map((row) => ({
    id: toNumber(row.id),
    conversationId: toNumber(row.conversation_id),
    fanId: row.fan_id == null ? null : toNumber(row.fan_id),
    createdAt: toDate(row.created_at),
    content: row.content,
  }));
}

/** Existing broadcast group whose window overlaps the cluster (run continuation). */
export async function findWb3BroadcastGroup(
  db: Database,
  input: {
    platformAccountId: number;
    contentHash: string;
    overlapStart: Date;
    overlapEnd: Date;
  },
): Promise<{ id: number } | null> {
  const rows = await db
    .select({ id: dmBroadcastGroups.id })
    .from(dmBroadcastGroups)
    .where(
      and(
        eq(dmBroadcastGroups.platformAccountId, input.platformAccountId),
        eq(dmBroadcastGroups.contentHash, input.contentHash),
        sql`${dmBroadcastGroups.lastSentAt} >= ${input.overlapStart}`,
        sql`${dmBroadcastGroups.firstSentAt} <= ${input.overlapEnd}`,
      ),
    )
    .orderBy(sql`${dmBroadcastGroups.lastSentAt} desc`)
    .limit(1);
  return rows[0] ?? null;
}

export async function createWb3BroadcastGroup(
  db: Database,
  input: {
    platformAccountId: number;
    contentHash: string;
    firstSentAt: Date;
    lastSentAt: Date;
  },
): Promise<number> {
  const [row] = await db
    .insert(dmBroadcastGroups)
    .values({
      platformAccountId: input.platformAccountId,
      contentHash: input.contentHash,
      firstSentAt: input.firstSentAt,
      lastSentAt: input.lastSentAt,
    })
    .returning({ id: dmBroadcastGroups.id });
  return row!.id;
}

export async function extendWb3BroadcastGroup(
  db: Database,
  input: { groupId: number; firstSentAt: Date; lastSentAt: Date },
): Promise<void> {
  await db.execute(sql`
    update dm_broadcast_groups
    set first_sent_at = least(first_sent_at, ${input.firstSentAt}),
        last_sent_at = greatest(last_sent_at, ${input.lastSentAt})
    where id = ${input.groupId}
  `);
}

/** Maps messages to a group; returns only the message pks that were new. */
export async function mapWb3BroadcastMessages(
  db: Database,
  input: { groupId: number; messagePks: number[] },
): Promise<number[]> {
  if (input.messagePks.length === 0) {
    return [];
  }
  const rows = await db
    .insert(dmBroadcastMessages)
    .values(input.messagePks.map((messagePk) => ({ messagePk, groupId: input.groupId })))
    .onConflictDoNothing()
    .returning({ messagePk: dmBroadcastMessages.messagePk });
  return rows.map((row) => row.messagePk);
}

export async function refreshWb3BroadcastGroupCount(
  db: Database,
  groupId: number,
): Promise<void> {
  await db.execute(sql`
    update dm_broadcast_groups
    set message_count = (select count(*) from dm_broadcast_messages where group_id = ${groupId})
    where id = ${groupId}
  `);
}

export async function insertWb3BroadcastTouches(
  db: Database,
  rows: Array<{
    platformAccountId: number;
    fanId: number;
    confirmedAt: Date;
    modelMessagePk: number;
  }>,
): Promise<number> {
  if (rows.length === 0) {
    return 0;
  }
  const inserted = await db
    .insert(workboardV3Touches)
    .values(
      rows.map((row) => ({
        platformAccountId: row.platformAccountId,
        fanId: row.fanId,
        type: "broadcast" as const,
        confirmedAt: row.confirmedAt,
        modelMessagePk: row.modelMessagePk,
        createdAt: row.confirmedAt,
      })),
    )
    .returning({ id: workboardV3Touches.id });
  return inserted.length;
}
