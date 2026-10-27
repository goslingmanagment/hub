import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// Fan marks (0325): a Fansly page's user lists and the members of the lists
// labelled «бомж». `fan-lists.poll` (apps/runtime/src/sync/fansly/resources/
// fan-lists.ts) writes them from its apply, in the transaction that journaled
// the answer; `clientFanMarks` reads a fan's memberships on every page.
//
// A walk has a generation, above every one the page used before. Each member
// it sees is stamped with it; when the walk has read every list it walks, the
// members of the page it did not see are retired. A row a newer walk stamped
// is never moved back by an older answer re-applied from the journal.

export interface PageFanListInput {
  listRef: string;
  label: string;
  type: number | null;
  itemCount: number | null;
}

const iso = (at: Date) => at.toISOString();
const count = (value: string | number | null | undefined) => Number(value ?? 0);

/**
 * Store one lists answer: every list it names (active again if it was not),
 * and the page's other lists inactive. Returns how many it retired.
 */
export async function upsertPageFanLists(
  db: Database,
  input: { pageId: number; lists: readonly PageFanListInput[]; observationId: number; capturedAt: Date },
): Promise<{ written: number; retired: number }> {
  const lists = [...new Map(input.lists.map((list) => [list.listRef, list])).values()];
  const at = sql`${iso(input.capturedAt)}::timestamptz`;
  if (lists.length > 0) {
    await db.execute(sql`
      insert into page_fan_lists (page_id, list_ref, label, list_type, item_count, is_active, observation_id, captured_at)
      select ${input.pageId}, l.list_ref, l.label, l.list_type, l.item_count, true, ${input.observationId}, ${at}
      from unnest(
        ${sql.param(lists.map((list) => list.listRef))}::text[],
        ${sql.param(lists.map((list) => list.label))}::text[],
        ${sql.param(lists.map((list) => list.type))}::int[],
        ${sql.param(lists.map((list) => list.itemCount))}::int[]
      ) as l(list_ref, label, list_type, item_count)
      on conflict (page_id, list_ref) do update set
        label = excluded.label,
        list_type = excluded.list_type,
        item_count = excluded.item_count,
        is_active = true,
        observation_id = excluded.observation_id,
        captured_at = excluded.captured_at
      where page_fan_lists.captured_at <= excluded.captured_at`);
  }
  const retired = await db.execute<{ n: string }>(sql`
    with gone as (
      update page_fan_lists set is_active = false, observation_id = ${input.observationId}, captured_at = ${at}
      where page_id = ${input.pageId} and is_active and captured_at <= ${at}
        and not (list_ref = any(${sql.param(lists.map((list) => list.listRef))}::text[]))
      returning 1
    )
    select count(*)::text as n from gone`);
  return { written: lists.length, retired: count(retired.rows[0]?.n) };
}

/** The highest walk generation the page used (0: none yet). */
export async function maxPageFanListGeneration(db: Database, pageId: number): Promise<number> {
  const result = await db.execute<{ g: string | null }>(sql`
    select greatest(
      (select max(last_seen_generation) from page_fan_list_members where page_id = ${pageId}),
      (select generation from page_fan_list_walks where page_id = ${pageId})
    )::text as g`);
  return count(result.rows[0]?.g);
}

/**
 * The fans one page of a list's members named, seen by the walk of
 * `generation`: active, stamped; a fan the walks had retired starts a new
 * membership (`first_seen_at`). Returns the rows written.
 */
export async function upsertPageFanListMembers(
  db: Database,
  input: { pageId: number; listRef: string; fanIds: readonly number[]; generation: number; seenAt: Date },
): Promise<number> {
  const fanIds = [...new Set(input.fanIds)];
  if (fanIds.length === 0) return 0;
  const at = sql`${iso(input.seenAt)}::timestamptz`;
  const result = await db.execute(sql`
    insert into page_fan_list_members (page_id, list_ref, fan_id, first_seen_at, last_seen_at, last_seen_generation, is_active)
    select ${input.pageId}, ${input.listRef}, f.fan_id, ${at}, ${at}, ${input.generation}, true
    from unnest(${sql.param(fanIds.map(String))}::bigint[]) as f(fan_id)
    on conflict (page_id, list_ref, fan_id) do update set
      first_seen_at = case when page_fan_list_members.is_active then page_fan_list_members.first_seen_at else excluded.first_seen_at end,
      last_seen_at = excluded.last_seen_at,
      last_seen_generation = excluded.last_seen_generation,
      is_active = true
    where page_fan_list_members.last_seen_generation <= excluded.last_seen_generation`);
  return result.rowCount ?? fanIds.length;
}

/**
 * A walk read every list it walks: the page's members it did not see are
 * retired (a list it did not walk any more included), and the walk is the
 * page's last. Returns how many it retired and saw.
 */
export async function finishPageFanListWalk(
  db: Database,
  input: { pageId: number; generation: number; completedAt: Date; listsWalked: number },
): Promise<{ retired: number; membersSeen: number }> {
  const retired = await db.execute<{ n: string }>(sql`
    with gone as (
      update page_fan_list_members set is_active = false
      where page_id = ${input.pageId} and is_active and last_seen_generation < ${input.generation}
      returning 1
    )
    select count(*)::text as n from gone`);
  const seen = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from page_fan_list_members
    where page_id = ${input.pageId} and last_seen_generation = ${input.generation} and is_active`);
  const membersSeen = count(seen.rows[0]?.n);
  await db.execute(sql`
    insert into page_fan_list_walks (page_id, generation, completed_at, lists_walked, members_seen)
    values (${input.pageId}, ${input.generation}, ${iso(input.completedAt)}::timestamptz, ${input.listsWalked}, ${membersSeen})
    on conflict (page_id) do update set
      generation = excluded.generation,
      completed_at = excluded.completed_at,
      lists_walked = excluded.lists_walked,
      members_seen = excluded.members_seen
    where page_fan_list_walks.generation <= excluded.generation`);
  return { retired: count(retired.rows[0]?.n), membersSeen };
}

/** A fan's current membership in a list of an active Fansly page. */
export interface FanListMembershipRow {
  pageId: number;
  pageLabel: string;
  modelName: string | null;
  listRef: string;
  label: string;
  since: Date;
}

/** Every current membership of the fan in a list a page still has, on the agency's active Fansly pages. */
export async function listFanListMemberships(db: Database, fanId: number): Promise<FanListMembershipRow[]> {
  const result = await db.execute<{
    page_id: string | number; page_label: string; model_name: string | null; list_ref: string; label: string;
    first_seen_at: Date | string;
  }>(sql`
    select m.page_id, p.label as page_label, mo.name as model_name, m.list_ref, l.label, m.first_seen_at
    from page_fan_list_members m
    join page_fan_lists l on l.page_id = m.page_id and l.list_ref = m.list_ref and l.is_active
    join pages p on p.id = m.page_id and p.platform = 'fansly' and p.status = 'active' and p.deleted_at is null
    left join models mo on mo.id = p.model_id
    where m.fan_id = ${fanId} and m.is_active
    order by p.label, m.list_ref`);
  return result.rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    modelName: row.model_name,
    listRef: row.list_ref,
    label: row.label,
    since: new Date(row.first_seen_at),
  }));
}

/**
 * The oldest last full walk of the lists among the agency's active Fansly
 * pages the engine runs (`sync_pages.mode = 'live'`); null while any of them
 * has never finished one, or there is none.
 */
export async function readFanListsReadAt(db: Database): Promise<Date | null> {
  const result = await db.execute<{ pages: string; walked: string; oldest: Date | string | null }>(sql`
    select count(*)::text as pages, count(w.completed_at)::text as walked, min(w.completed_at) as oldest
    from pages p
    join sync_pages sp on sp.page_id = p.id and sp.mode = 'live'
    left join page_fan_list_walks w on w.page_id = p.id
    where p.platform = 'fansly' and p.status = 'active' and p.deleted_at is null`);
  const row = result.rows[0];
  if (row === undefined || count(row.pages) === 0 || count(row.walked) < count(row.pages) || row.oldest === null) return null;
  return new Date(row.oldest);
}
