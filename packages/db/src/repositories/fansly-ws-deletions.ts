// D-6 / DMWS-01 / F32: Fansly DM deletions reported by the account socket.
//
// A deletion arrives as a serviceId 5 / event type 10 frame. B0 journals the
// frame, the WS canonicalizer extracts its exact native address, and the hint
// projector keeps it as a `mutation_debt` receipt, the same evidence that
// `source_deleted` settlement uses (fansly-ws-hints.ts). The writers here turn
// that receipt into a platform-deletion MARK on the rows Hub already holds:
// page_dm_messages.deleted_at and message_archive.deleted_at. Text,
// attachments, tips, reply refs and purchase state stay; the owner decided a
// Fansly deletion is a fact about the message, not an erasure (2026-09-28).
// Nothing is inserted, so a message deleted before Hub captured it stays
// absent. Erasure deletes the receipts with the fan's rows, so a mark can
// never reach erased material.
//
// Evidence is exact: page + native group + native message from a frame with
// a known credential/route generation. A correlation or bulk marker is never
// expanded to other recipients' copies. The earliest receipt dates the
// deletion, so every caller writes the same timestamp.
//
// Three callers, one fact definition (the PPV purchase precedent):
//   * the minutely reconcile of recently FILED receipts in the message-archive
//     sweep,
//   * the owner-run history backfill (archive:backfill-fansly-ws-deletions),
//   * the message-archive shadow rebuild (re-marks the shadow after replay).
// Every writer is conditional on the row not being marked yet, so any caller
// can re-run it.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import type { ArchiveTargetTable } from "./message-archive.ts";

export interface FanslyWsDeletionScope {
  /** One internal page id; null/absent = every Fansly page. */
  accountId?: number | null;
  /** Only addresses with an exact receipt FILED (fansly_ws_hint_receipts.
   * created_at) at or after this instant: the minutely reconcile. Filing time,
   * not frame time, so a hint projector backlog cannot age a receipt out of
   * the window before it is filed. null/absent = all history. */
  filedSince?: Date | null;
}

function archiveTarget(target: ArchiveTargetTable) {
  if (target !== "message_archive" && target !== "message_archive_shadow") {
    throw new Error(`Unknown archive target table: ${String(target)}`);
  }
  return sql.raw(target);
}

/** Earliest exact deletion receipt per (page, group, message). The predicate
 * matches the partial index fansly_ws_hint_exact_delete. With `filedSince`,
 * only addresses with a receipt filed in the window are selected, but the date
 * is still the earliest receipt of ALL of them, so every caller writes the same
 * timestamp. */
function deletionsCte(scope: FanslyWsDeletionScope): SQL {
  const accountFilter = scope.accountId == null ? sql`` : sql`and r.page_id = ${scope.accountId}`;
  const filedFilter = scope.filedSince == null ? sql`` : sql`
        and exists (
          select 1 from fansly_ws_hint_receipts f
          where f.page_id = r.page_id and f.group_ref = r.group_ref
            and f.message_ref = r.message_ref and f.outcome = 'mutation_debt'
            and f.generation is not null and f.created_at >= ${scope.filedSince}
        )`;
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
        ${filedFilter}
      group by r.page_id, r.group_ref, r.message_ref
    )`;
}

/** Hot rows still live for an exact deletion. Joined through the
 * (account, message) index, then checked against the thread's native group. */
const hotTargetsFrom = sql`
  from deletions d
  join page_dm_messages m
    on m.platform_account_id = d.page_id and m.platform_message_id = d.message_ref
  join page_dm_threads t
    on t.id = m.conversation_id and t.platform_conversation_id = d.group_ref
  where m.deleted_at is null`;

/** Archive rows still live for an exact deletion. A row without a
 * conversation ref cannot contradict the group, so the page + native id
 * (a Fansly snowflake) identifies it. */
const archiveTargetsWhere = sql`
  ma.account_id = d.page_id
  and ma.platform = 'fansly'
  and ma.message_ref = d.message_ref
  and (ma.conversation_ref is null or ma.conversation_ref = d.group_ref)
  and ma.deleted_at is null`;

export interface FanslyWsHotDeletionTarget {
  /** page_dm_messages.id */
  id: number;
  pageId: number;
  conversationId: number;
  platformMessageId: string;
  deletedAt: Date;
}

export interface FanslyWsDeletionPageCount {
  pageId: number;
  pageLabel: string;
  /** Distinct exact deletion addresses in scope. */
  deletions: number;
  /** Live hot rows a deletion names. */
  hot: number;
  /** Live message_archive rows a deletion names. */
  archive: number;
}

export async function listFanslyWsHotDeletionTargets(
  db: Database,
  scope: FanslyWsDeletionScope,
): Promise<FanslyWsHotDeletionTarget[]> {
  const result = await db.execute<{
    id: string; platform_account_id: string; conversation_id: string;
    platform_message_id: string; deleted_at: Date | string;
  }>(sql`
    with ${deletionsCte(scope)}
    select m.id, m.platform_account_id, m.conversation_id, m.platform_message_id, d.deleted_at
    ${hotTargetsFrom}
    order by m.conversation_id, m.id
  `);
  return result.rows.map((row) => ({
    id: Number(row.id),
    pageId: Number(row.platform_account_id),
    conversationId: Number(row.conversation_id),
    platformMessageId: row.platform_message_id,
    deletedAt: new Date(row.deleted_at),
  }));
}

/** Marks one hot row deleted on the platform, keeping its content. False when
 * it is already marked (or gone). The caller refreshes the thread window. */
export async function markFanslyWsHotDeletion(
  db: Database,
  target: Pick<FanslyWsHotDeletionTarget, "id" | "deletedAt">,
): Promise<boolean> {
  const result = await db.execute(sql`
    update page_dm_messages set deleted_at = ${target.deletedAt}
    where id = ${target.id} and deleted_at is null
    returning id
  `);
  return result.rows.length > 0;
}

/**
 * Threads in scope whose stored window still counts a marked row: the newest
 * or oldest stored id names a marked row, or stored_message_count exceeds the
 * live rows. The mark's own window refresh runs outside the page sync lease,
 * and the Fansly conversation-list writer writes the window back from a
 * snapshot it read before its transaction. A list chunk in flight across a
 * mark can therefore revert the refresh; the reconcile re-derives these
 * windows on its next pass. Only threads holding a row an in-scope exact
 * receipt marked are considered, so an in-flight REST walk (which only adds
 * rows and recomputes the window itself) is not touched.
 */
export async function listFanslyWsDeletionWindowDrift(
  db: Database,
  scope: FanslyWsDeletionScope,
): Promise<number[]> {
  const result = await db.execute<{ id: string }>(sql`
    with ${deletionsCte(scope)},
    threads as (
      select distinct m.conversation_id as id
      from deletions d
      join page_dm_messages m
        on m.platform_account_id = d.page_id and m.platform_message_id = d.message_ref
      join page_dm_threads t
        on t.id = m.conversation_id and t.platform_conversation_id = d.group_ref
      where m.deleted_at is not null
    )
    select t.id::text as id
    from threads x
    join page_dm_threads t on t.id = x.id
    where exists (
        select 1 from page_dm_messages n
        where n.conversation_id = t.id and n.deleted_at is not null
          and n.platform_message_id in (t.newest_stored_message_id, t.oldest_stored_message_id)
      )
      or t.stored_message_count > (
        select count(*) from page_dm_messages l
        where l.conversation_id = t.id and l.deleted_at is null
      )
    order by t.id
  `);
  return result.rows.map((row) => Number(row.id));
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

/** Per-page census of what the writers above would mark (dry-run). */
export async function countFanslyWsDeletionsByPage(
  db: Database,
  scope: FanslyWsDeletionScope,
): Promise<FanslyWsDeletionPageCount[]> {
  const result = await db.execute<{
    page_id: string; label: string; deletions: string; hot: string; archive: string;
  }>(sql`
    with ${deletionsCte(scope)},
    hot as (
      select m.platform_account_id as page_id, count(*) as n
      ${hotTargetsFrom}
      group by m.platform_account_id
    ),
    archive as (
      select d.page_id, count(*) as n
      from deletions d
      join message_archive ma on ${archiveTargetsWhere}
      group by d.page_id
    ),
    per_page as (
      select page_id, count(*) as n from deletions group by page_id
    )
    select p.id::text as page_id, p.label, pp.n::text as deletions,
      coalesce(h.n, 0)::text as hot, coalesce(a.n, 0)::text as archive
    from per_page pp
    join pages p on p.id = pp.page_id
    left join hot h on h.page_id = pp.page_id
    left join archive a on a.page_id = pp.page_id
    order by p.label
  `);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.label,
    deletions: Number(row.deletions),
    hot: Number(row.hot),
    archive: Number(row.archive),
  }));
}
