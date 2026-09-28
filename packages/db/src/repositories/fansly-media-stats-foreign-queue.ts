// media_stats: the one-off foreign-media queue repair (M11).
//
// Kept in its own file so the retention-deleter guard sanctions this owner-run
// repair alone, not the whole engagement repository.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";

export interface ForeignMediaStatsQueueCount {
  pageId: number;
  pageLabel: string;
  /** Never-visited `media_stats` rows whose media belongs to another account. */
  rows: number;
  /** Of those, the rows that have already failed at least once. */
  failing: number;
}

/**
 * The `media_stats` queue rows of media the page does NOT own: the ones
 * `upsertCreatorMedia` queued for the media fans sent in DMs before it learned
 * to skip them. The route cannot serve another account's media offer, so every
 * look at such a row is a guaranteed `error getting media offer`; with the
 * failure backoff honoured that is still one failed look per row per day.
 *
 * `creator_media` keeps no owner, so the owner is read from the `media.observed`
 * events the head was projected from. A row qualifies only when
 *
 *   - it was never visited (a served window proves the page can read it), and
 *   - the page has at least one `media.observed` event for it, and EVERY one
 *     names an owner that differs from the page's own account ref.
 *
 * An event with no owner, a page with no account ref, or a ref observed even
 * once as the page's own keeps the row. Events in a detached partition are not
 * seen; a media's owner does not change, so the attached ones are the same
 * evidence.
 *
 * It reads every `media.observed` event of the page(s) once — a one-off's
 * cost, which is why an owner runs it and the lane never does.
 */
function foreignMediaStatsRows(pageId: number | null): SQL {
  return sql`
    with owners as (
      select e.account_id as page_id,
             e.data ->> 'mediaOfferRef' as subject_ref,
             bool_and(
               coalesce(e.data ->> 'ownerAccountRef' <> p.external_page_id, false)
             ) as foreign_only
        from domain_events e
        join pages p on p.id = e.account_id
       where e.type = 'media.observed'
         and e.data ->> 'subject' = 'media'
         and (${pageId}::bigint is null or e.account_id = ${pageId}::bigint)
       group by e.account_id, e.data ->> 'mediaOfferRef'
    )
    select s.page_id, s.subject_ref, s.consecutive_failures
      from subject_refresh_state s
      join owners o
        on o.page_id = s.page_id
       and o.subject_ref = s.subject_ref
     where s.plane = 'media_stats'
       and s.last_visited_at is null
       and o.foreign_only
  `;
}

type ForeignMediaStatsCountRow = {
  page_id: number | string;
  page_label: string;
  rows: string;
  failing: string;
};

function foreignMediaStatsCounts(rows: ForeignMediaStatsCountRow[]): ForeignMediaStatsQueueCount[] {
  return rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    rows: Number(row.rows),
    failing: Number(row.failing),
  }));
}

/** Per page, the rows `deleteForeignMediaStatsQueueRows` would delete. */
export async function countForeignMediaStatsQueueRows(
  db: Database,
  input: { pageId: number | null },
): Promise<ForeignMediaStatsQueueCount[]> {
  const result = await db.execute<ForeignMediaStatsCountRow>(sql`
    with foreign_rows as (${foreignMediaStatsRows(input.pageId)})
    select f.page_id,
           p.label as page_label,
           count(*)::text as rows,
           count(*) filter (where f.consecutive_failures > 0)::text as failing
      from foreign_rows f
      join pages p on p.id = f.page_id
     group by f.page_id, p.label
     order by f.page_id
  `);
  return foreignMediaStatsCounts(result.rows);
}

/**
 * Delete the foreign rows (see `foreignMediaStatsRows`). Operational queue
 * state, not captured facts: no row it removes ever held an answer, the
 * `creator_media` heads and every observation stay, and the owner check in
 * `upsertCreatorMedia` keeps the rows from coming back. Idempotent — a second
 * run deletes nothing.
 */
export async function deleteForeignMediaStatsQueueRows(
  db: Database,
  input: { pageId: number | null },
): Promise<ForeignMediaStatsQueueCount[]> {
  const result = await db.execute<ForeignMediaStatsCountRow>(sql`
    with foreign_rows as (${foreignMediaStatsRows(input.pageId)}),
    deleted as (
      delete from subject_refresh_state s
       using foreign_rows f
       where s.page_id = f.page_id
         and s.plane = 'media_stats'
         and s.subject_ref = f.subject_ref
         and s.last_visited_at is null
      returning s.page_id, s.consecutive_failures
    )
    select d.page_id,
           p.label as page_label,
           count(*)::text as rows,
           count(*) filter (where d.consecutive_failures > 0)::text as failing
      from deleted d
      join pages p on p.id = d.page_id
     group by d.page_id, p.label
     order by d.page_id
  `);
  return foreignMediaStatsCounts(result.rows);
}
