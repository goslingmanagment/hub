// D-6 / DMWS-01 / F32: Fansly DM deletions reported by the account socket.
//
// A deletion arrives as a serviceId 5 / event type 10 frame. A Fansly
// deletion is a fact about the message, not an erasure (owner, 2026-09-28):
// the stored copies are MARKED deleted (page_dm_messages.deleted_at,
// message_archive.deleted_at) and their text, attachments, tips, reply refs
// and purchase state stay. Nothing is inserted, so a message deleted before
// Hub captured it stays absent.
//
// Since step 4 (S4-11) the Fansly Sync Engine's `dm-live.deletions` is the
// only path from a socket deletion to the stores: it marks the hot rows with
// `markFanslyWsHotDeletion` and tombstones the archive from its own
// `message.deleted` event. Before that, the retired ws-hints projector kept
// each deletion as an exact `mutation_debt` receipt in
// fansly_ws_hint_receipts, and a minutely reconcile turned the receipts into
// marks. Those receipts stay as records: no event carries those marks, so the
// message-archive shadow rebuild re-applies them (`markFanslyWsArchiveDeletions`).
// Erasure deletes the receipts with the fan's rows, so a mark can never reach
// erased material.
//
// Evidence is exact: page + native group + native message from a frame with
// a known credential/route generation. A correlation or bulk marker is never
// expanded to other recipients' copies. The earliest receipt dates the
// deletion. Every writer is conditional on the row not being marked yet, so
// any caller can re-run it.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { ArchiveTargetTable } from "./message-archive.ts";

export interface FanslyWsDeletionScope {
  /** One internal page id; null/absent = every Fansly page. */
  accountId?: number | null;
}

function archiveTarget(target: ArchiveTargetTable) {
  if (target !== "message_archive" && target !== "message_archive_shadow") {
    throw new Error(`Unknown archive target table: ${String(target)}`);
  }
  return sql.raw(target);
}

/** Earliest exact deletion receipt per (page, group, message). The predicate
 * matches the partial index fansly_ws_hint_exact_delete. */
function deletionsCte(scope: FanslyWsDeletionScope): SQL {
  const accountFilter = scope.accountId == null ? sql`` : sql`and r.page_id = ${scope.accountId}`;
  return sql`
    deletions as (
      select r.page_id, r.group_ref, r.message_ref, min(r.received_at) as deleted_at
      from fansly_ws_hint_receipts r
      join pages p on p.id = r.page_id and p.platform = 'fansly'
      where r.outcome = 'mutation_debt'
        and r.generation is not null
        and r.group_ref is not null
        and r.message_ref is not null
        ${accountFilter}
      group by r.page_id, r.group_ref, r.message_ref
    )`;
}

/** Archive rows still live for an exact deletion. A row without a
 * conversation ref cannot contradict the group, so the page + native id
 * (a Fansly snowflake) identifies it. */
const archiveTargetsWhere = sql`
  ma.account_id = d.page_id
  and ma.platform = 'fansly'
  and ma.message_ref = d.message_ref
  and (ma.conversation_ref is null or ma.conversation_ref = d.group_ref)
  and ma.deleted_at is null`;

/** Marks one hot row (page_dm_messages.id) deleted on the platform, keeping
 * its content. False when it is already marked (or gone). The caller
 * recomputes the thread window. */
export async function markFanslyWsHotDeletion(
  db: Database,
  target: { id: number; deletedAt: Date },
): Promise<boolean> {
  const result = await db.execute(sql`
    update page_dm_messages set deleted_at = ${target.deletedAt}
    where id = ${target.id} and deleted_at is null
    returning id
  `);
  return result.rows.length > 0;
}

/** message_archive (or its shadow): deleted_at for every exact deletion, text
 * and media untouched. Returns rows marked. */
export async function markFanslyWsArchiveDeletions(
  db: Database,
  scope: FanslyWsDeletionScope,
  target: ArchiveTargetTable = "message_archive",
): Promise<number> {
  const table = archiveTarget(target);
  const result = await db.execute<{ n: string }>(sql`
    with ${deletionsCte(scope)},
    marked as (
      update ${table} ma set deleted_at = d.deleted_at, updated_at = now()
      from deletions d
      where ${archiveTargetsWhere}
      returning 1
    )
    select count(*)::text as n from marked
  `);
  return Number(result.rows[0]?.n ?? 0);
}
