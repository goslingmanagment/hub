import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// OnlyFans vault lists (0394, 8-docs 2026-11-12-of-vault-album, plan PR 3):
// every vault list of a page as Hub last walked it, and the page's walk state.
// The walk itself (apps/runtime/src/services/onlyfans-vault-lists.ts) reads
// GET /media/vault/lists as owner actions; this file only stores what it saw.
//
// «Missing» is concluded only from a COMPLETE walk (it reached the list's
// end): the page's lists it did not see get missing_since. A walk cut short
// stores what it saw and marks nothing missing. A list seen again by any walk
// is not missing any more.

export interface OnlyfansVaultListInput {
  listRef: string;
  name: string;
  /** custom, posts, messages, stories, streams, media_stickers, ... as OnlyFans names it. */
  type: string;
  mediaCount: number | null;
}

export interface OnlyfansVaultListRow extends OnlyfansVaultListInput {
  firstSeenAt: Date;
  lastSeenAt: Date;
  missingSince: Date | null;
}

export interface OnlyfansVaultListWalkState {
  pageId: number;
  requestedAt: Date | null;
  requestedByUserId: number | null;
  completedAt: Date | null;
  completedRequests: number | null;
  failedAt: Date | null;
  failure: string | null;
}

type Row = Record<string, unknown>;
const date = (value: unknown): Date | null => (value === null || value === undefined ? null : new Date(value as string));
const nullableNum = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));

/** The screen's «Обновить альбомы»: the minutely job walks the page on its next turn, as `userId`. */
export async function requestOnlyfansVaultListWalk(db: Database, input: { pageId: number; userId: number }): Promise<void> {
  await db.execute(sql`
    insert into onlyfans_vault_list_walks (page_id, requested_at, requested_by_user_id, updated_at)
    values (${input.pageId}, date_trunc('milliseconds', now()), ${input.userId}, now())
    on conflict (page_id) do update set
      requested_at = coalesce(onlyfans_vault_list_walks.requested_at, date_trunc('milliseconds', now())),
      requested_by_user_id = excluded.requested_by_user_id, updated_at = now()
  `);
}

/** Pages with a walk asked for, oldest request first: active OnlyFans pages bound to an OnlyFansAPI account. */
export async function listRequestedOnlyfansVaultListWalks(db: Database): Promise<OnlyfansVaultListWalkState[]> {
  const result = await db.execute<Row>(sql`
    select w.* from onlyfans_vault_list_walks w
      join pages pg on pg.id = w.page_id
     where w.requested_at is not null
       and pg.platform::text = 'onlyfans' and pg.status = 'active' and pg.deleted_at is null
       and pg.ofapi_account_id is not null
     order by w.requested_at, w.page_id
  `);
  return result.rows.map(walkState);
}

export async function getOnlyfansVaultListWalk(db: Database, pageId: number): Promise<OnlyfansVaultListWalkState | null> {
  const result = await db.execute<Row>(sql`select * from onlyfans_vault_list_walks where page_id = ${pageId}`);
  return result.rows[0] ? walkState(result.rows[0]) : null;
}

function walkState(row: Row): OnlyfansVaultListWalkState {
  return {
    pageId: Number(row.page_id),
    requestedAt: date(row.requested_at),
    requestedByUserId: nullableNum(row.requested_by_user_id),
    completedAt: date(row.completed_at),
    completedRequests: nullableNum(row.completed_requests),
    failedAt: date(row.failed_at),
    failure: row.failure === null || row.failure === undefined ? null : String(row.failure),
  };
}

/**
 * Store one walk of the page's vault lists, in one transaction: every list it
 * saw (not missing, whatever it was); when `complete`, the page's other lists
 * missing since `seenAt`; the walk's outcome; and the request it answered is
 * done (a newer press stays). `failure` says why a walk is not complete.
 */
export async function applyOnlyfansVaultListWalk(db: Database, input: {
  pageId: number;
  seenAt: Date;
  lists: readonly OnlyfansVaultListInput[];
  complete: boolean;
  requests: number;
  failure: string | null;
  answeredRequestAt: Date | null;
}): Promise<{ written: number; markedMissing: number }> {
  const lists = [...new Map(input.lists.map((list) => [list.listRef, list])).values()];
  const at = sql`${input.seenAt.toISOString()}::timestamptz`;
  const answered = input.answeredRequestAt === null
    ? sql`false`
    // To the millisecond, as the Date that names the request: a request stored with
    // microseconds was never "at or before" its own Date, stayed pending, and the
    // minutely job walked the page again every minute.
    : sql`date_trunc('milliseconds', onlyfans_vault_list_walks.requested_at) <= ${input.answeredRequestAt.toISOString()}::timestamptz`;
  return db.transaction(async (tx) => {
    if (lists.length > 0) {
      await tx.execute(sql`
        insert into onlyfans_vault_lists (page_id, list_ref, name, list_type, media_count, first_seen_at, last_seen_at, missing_since)
        select ${input.pageId}, l.list_ref, l.name, l.list_type, l.media_count, ${at}, ${at}, null
          from unnest(
            ${sql.param(lists.map((list) => list.listRef))}::text[],
            ${sql.param(lists.map((list) => list.name))}::text[],
            ${sql.param(lists.map((list) => list.type))}::text[],
            ${sql.param(lists.map((list) => list.mediaCount))}::integer[]
          ) as l(list_ref, name, list_type, media_count)
        on conflict (page_id, list_ref) do update set
          name = excluded.name, list_type = excluded.list_type, media_count = excluded.media_count,
          last_seen_at = excluded.last_seen_at, missing_since = null
        where onlyfans_vault_lists.last_seen_at <= excluded.last_seen_at
      `);
    }
    let markedMissing = 0;
    if (input.complete) {
      const marked = await tx.execute<Row>(sql`
        update onlyfans_vault_lists set missing_since = ${at}
         where page_id = ${input.pageId} and missing_since is null and last_seen_at < ${at}
           and not (list_ref = any(${sql.param(lists.map((list) => list.listRef))}::text[]))
        returning list_ref
      `);
      markedMissing = marked.rows.length;
    }
    await tx.execute(sql`
      insert into onlyfans_vault_list_walks (page_id, completed_at, completed_requests, failed_at, failure, updated_at)
      values (
        ${input.pageId},
        ${input.complete ? at : null}, ${input.complete ? input.requests : null},
        ${input.complete ? null : at}, ${input.complete ? null : (input.failure ?? "incomplete").slice(0, 300)}, now()
      )
      on conflict (page_id) do update set
        completed_at = coalesce(excluded.completed_at, onlyfans_vault_list_walks.completed_at),
        completed_requests = coalesce(excluded.completed_requests, onlyfans_vault_list_walks.completed_requests),
        failed_at = coalesce(excluded.failed_at, onlyfans_vault_list_walks.failed_at),
        failure = coalesce(excluded.failure, onlyfans_vault_list_walks.failure),
        requested_at = case when ${answered} then null else onlyfans_vault_list_walks.requested_at end,
        requested_by_user_id = case when ${answered} then null else onlyfans_vault_list_walks.requested_by_user_id end,
        updated_at = now()
    `);
    return { written: lists.length, markedMissing };
  });
}

/** The page's vault lists as Hub knows them, the missing ones too; custom albums first, then by name. */
export async function listOnlyfansVaultLists(db: Database, pageId: number): Promise<OnlyfansVaultListRow[]> {
  const result = await db.execute<Row>(sql`
    select * from onlyfans_vault_lists where page_id = ${pageId}
     order by (list_type = 'custom') desc, missing_since is not null, lower(name), list_ref
  `);
  return result.rows.map((row) => ({
    listRef: String(row.list_ref),
    name: String(row.name),
    type: String(row.list_type),
    mediaCount: nullableNum(row.media_count),
    firstSeenAt: date(row.first_seen_at)!,
    lastSeenAt: date(row.last_seen_at)!,
    missingSince: date(row.missing_since),
  }));
}

/** Whether the page is an active OnlyFans page bound to an OnlyFansAPI account: null when it is not an OnlyFans page at all. */
export async function onlyfansVaultListPageBound(db: Database, pageId: number): Promise<boolean | null> {
  const result = await db.execute<Row>(sql`
    select (status = 'active' and deleted_at is null and ofapi_account_id is not null) as bound
      from pages where id = ${pageId} and platform::text = 'onlyfans'
  `);
  const row = result.rows[0];
  return row ? row.bound === true : null;
}
