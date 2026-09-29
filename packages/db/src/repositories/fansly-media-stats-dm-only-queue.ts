// media_stats: the one-off DM-only queue repair.
//
// Kept in its own file so the retention-deleter guard sanctions this owner-run
// repair alone, not the whole engagement repository.

import { sql, type SQL } from "drizzle-orm";

import type { Database } from "../client.ts";
import { MEDIA_STATS_QUEUE_ORIGINS } from "./media-plane.ts";

export interface DmOnlyMediaStatsQueueCount {
  pageId: number;
  pageLabel: string;
  /** `media_stats` rows of media the page showed only in DMs. */
  rows: number;
  /** Of those, the rows the lane has visited: their buckets are kept. */
  visited: number;
  /** Of those, the rows a purchase or the top-50 had marked dirty. */
  dirty: number;
  /** Of those, the rows no `creator_media` head names — purchase marks the
   *  chunk query never admitted, left by the mark's old insert. */
  headless: number;
}

/**
 * The `media_stats` queue rows of media the page showed ONLY IN DMs: the ones
 * `upsertCreatorMedia` queued from a DM sidecar, and the purchase marks queued
 * for refs no head names, before both learned to leave them out. Owner decision
 * 2026-09-29: the per-media views of media the model sent only in DMs are not
 * wanted (~10 k of a 19 k queue, 3 % of the views).
 *
 * A row is KEPT when anything shows its media outside a DM:
 *
 *   - the row's own `media_shown_outside_dm_at`: the enqueue queued it, or
 *     re-confirmed it, from a post or the account statistics. This is the
 *     evidence that cannot lag the queue — it is written by the statement that
 *     queues — so it keeps a DM-first media the media plane has seen on a post
 *     before `creator_posts` has projected that post;
 *   - a post names it as an attachment — which also keeps the headless mark of
 *     a post's media bought before its head was projected;
 *   - it is a member of a bundle a post names, by the bundle's `member_refs` or
 *     by the media's own `bundle_refs`;
 *   - `stats_top_media` names it, in any window;
 *   - its head was first seen from an origin the enqueue queues
 *     (`MEDIA_STATS_QUEUE_ORIGINS`) — a post's media whose post head is not
 *     projected, or a ranked item.
 *
 * The other rules read projections — `creator_posts`, the bundles,
 * `stats_top_media`, the heads — and they are what keep the rows queued before
 * 0222, which carry no stamp. So the repair runs only once the projectors that
 * write them have caught up with the journal (`checkDmOnlyPruneProjections`).
 *
 * Every other row goes, visited or not and dirty or not. Visited is not a
 * reason to keep it, as it is for the foreign repair: the page CAN read these,
 * it is that nobody wants the numbers. What the lane collected stays in
 * `stats_traffic_buckets`; this deletes only the queue row.
 */
function dmOnlyMediaStatsRows(pageId: number | null): SQL {
  const queueOrigins = sql.join(
    [...MEDIA_STATS_QUEUE_ORIGINS].map((origin) => sql`${origin}`),
    sql`, `,
  );
  return sql`
    with post_refs as (
      select p.account_id as page_id, a.attachment ->> 'contentId' as content_ref
        from creator_posts p
        cross join lateral jsonb_array_elements(
          case when jsonb_typeof(p.attachment_refs) = 'array'
               then p.attachment_refs else '[]'::jsonb end
        ) as a(attachment)
       where p.platform = 'fansly'
         and (${pageId}::bigint is null or p.account_id = ${pageId}::bigint)
    ),
    shown as (
      select r.page_id, r.content_ref as subject_ref
        from post_refs r
       where r.content_ref is not null
      union
      select b.page_id, member.ref
        from creator_media_bundles b
        join post_refs r
          on r.page_id = b.page_id
         and r.content_ref = b.bundle_ref
       cross join lateral unnest(b.member_refs) as member(ref)
      union
      select m.page_id, m.media_offer_ref
        from creator_media m
        join post_refs r
          on r.page_id = m.page_id
         and r.content_ref = any(m.bundle_refs)
       where m.platform = 'fansly'
      union
      select t.page_id, t.media_offer_ref
        from stats_top_media t
       where (${pageId}::bigint is null or t.page_id = ${pageId}::bigint)
      union
      select m.page_id, m.media_offer_ref
        from creator_media m
       where m.platform = 'fansly'
         and m.first_origin in (${queueOrigins})
         and (${pageId}::bigint is null or m.page_id = ${pageId}::bigint)
    )
    select s.page_id,
           s.subject_ref,
           s.last_visited_at,
           s.dirty_reason,
           m.media_offer_ref is null as headless
      from subject_refresh_state s
      left join creator_media m
        on m.page_id = s.page_id
       and m.platform = 'fansly'
       and m.media_offer_ref = s.subject_ref
     where s.plane = 'media_stats'
       and (${pageId}::bigint is null or s.page_id = ${pageId}::bigint)
       and s.media_shown_outside_dm_at is null
       and not exists (
         select 1 from shown k
          where k.page_id = s.page_id
            and k.subject_ref = s.subject_ref
       )
  `;
}

export interface DmOnlyPruneProjectionLag {
  pageId: number;
  pageLabel: string;
  projection: string;
  /** The projector's watermark on the page; 0 when it has none yet. */
  watermark: number;
  /** The journal head it is held to. */
  head: number;
}

/**
 * For every page holding `media_stats` rows in scope, the journal head, and
 * each of `projections` still BEHIND it: a retained domain event in
 * (watermark, head] it has not consumed. It probes for an event rather than
 * comparing numbers, so an erased tail event does not hold a projector back.
 *
 * `heads` pins the head per page — the caller's first read — so a page whose
 * journal keeps growing cannot keep moving the target; a page absent from it is
 * held to its head now. Holding the projectors to a head read after the deploy
 * is enough: every event the old enqueue projected is at or below it.
 */
export async function checkDmOnlyPruneProjections(
  db: Database,
  input: {
    pageId: number | null;
    projections: readonly string[];
    heads?: ReadonlyMap<number, number>;
  },
): Promise<{ heads: Map<number, number>; lagging: DmOnlyPruneProjectionLag[] }> {
  if (input.projections.length === 0) {
    throw new Error("checkDmOnlyPruneProjections needs at least one projection");
  }
  const pinned = [...(input.heads ?? new Map<number, number>())];
  const pinnedRows = pinned.length === 0
    ? sql`select null::bigint as page_id, null::bigint as head where false`
    : sql`values ${sql.join(
      pinned.map(([pageId, head]) => sql`(${pageId}::bigint, ${head}::bigint)`),
      sql`, `,
    )}`;
  const projections = sql.join(
    input.projections.map((projection) => sql`(${projection}::text)`),
    sql`, `,
  );
  const result = await db.execute<{
    page_id: number | string;
    page_label: string;
    projection: string;
    watermark: string;
    head: string;
    behind: boolean;
  }>(sql`
    with pinned(page_id, head) as (${pinnedRows}),
    scope as (
      select p.id as page_id,
             p.label as page_label,
             coalesce(pinned.head, seq.next_seq - 1, 0) as head
        from pages p
        left join pinned on pinned.page_id = p.id
        left join domain_event_seq seq on seq.account_id = p.id
       where (${input.pageId}::bigint is null or p.id = ${input.pageId}::bigint)
         and exists (
           select 1 from subject_refresh_state r
            where r.page_id = p.id
              and r.plane = 'media_stats'
         )
    ),
    projection(name) as (values ${projections})
    select sc.page_id,
           sc.page_label,
           pr.name as projection,
           coalesce(w.high_seq, 0)::text as watermark,
           sc.head::text as head,
           exists (
             select 1 from domain_events de
              where de.account_id = sc.page_id
                and de.account_seq > coalesce(w.high_seq, 0)
                and de.account_seq <= sc.head
           ) as behind
      from scope sc
     cross join projection pr
      left join projection_seq_watermarks w
        on w.projection = pr.name
       and w.account_id = sc.page_id
     order by sc.page_id, pr.name
  `);
  const heads = new Map<number, number>();
  const lagging: DmOnlyPruneProjectionLag[] = [];
  for (const row of result.rows) {
    heads.set(Number(row.page_id), Number(row.head));
    if (row.behind) {
      lagging.push({
        pageId: Number(row.page_id),
        pageLabel: row.page_label,
        projection: row.projection,
        watermark: Number(row.watermark),
        head: Number(row.head),
      });
    }
  }
  return { heads, lagging };
}

type DmOnlyMediaStatsCountRow = {
  page_id: number | string;
  page_label: string;
  rows: string;
  visited: string;
  dirty: string;
  headless: string;
};

function dmOnlyMediaStatsCounts(rows: DmOnlyMediaStatsCountRow[]): DmOnlyMediaStatsQueueCount[] {
  return rows.map((row) => ({
    pageId: Number(row.page_id),
    pageLabel: row.page_label,
    rows: Number(row.rows),
    visited: Number(row.visited),
    dirty: Number(row.dirty),
    headless: Number(row.headless),
  }));
}

/** Per page, the rows `deleteDmOnlyMediaStatsQueueRows` would delete. */
export async function countDmOnlyMediaStatsQueueRows(
  db: Database,
  input: { pageId: number | null },
): Promise<DmOnlyMediaStatsQueueCount[]> {
  const result = await db.execute<DmOnlyMediaStatsCountRow>(sql`
    with dm_only as (${dmOnlyMediaStatsRows(input.pageId)})
    select d.page_id,
           p.label as page_label,
           count(*)::text as rows,
           count(*) filter (where d.last_visited_at is not null)::text as visited,
           count(*) filter (where d.dirty_reason is not null)::text as dirty,
           count(*) filter (where d.headless)::text as headless
      from dm_only d
      join pages p on p.id = d.page_id
     group by d.page_id, p.label
     order by d.page_id
  `);
  return dmOnlyMediaStatsCounts(result.rows);
}

/**
 * Delete the DM-only rows (see `dmOnlyMediaStatsRows`). Operational queue
 * state, not captured facts: the `creator_media` heads, the collected buckets
 * and every observation stay, and the enqueue's and the first-enable seed's
 * origin check and the purchase mark's update-only rule keep the rows from
 * coming back. Idempotent — a second run deletes nothing.
 *
 * The stamp is checked again on the row being deleted, not only in the CTE: an
 * enqueue that stamps it concurrently then keeps it (a READ COMMITTED delete
 * re-checks the row it waited for; a REPEATABLE READ one fails instead of
 * deleting it). The caller runs the projector check first, in the same
 * transaction.
 */
export async function deleteDmOnlyMediaStatsQueueRows(
  db: Database,
  input: { pageId: number | null },
): Promise<DmOnlyMediaStatsQueueCount[]> {
  const result = await db.execute<DmOnlyMediaStatsCountRow>(sql`
    with dm_only as (${dmOnlyMediaStatsRows(input.pageId)}),
    deleted as (
      delete from subject_refresh_state s
       using dm_only d
       where s.page_id = d.page_id
         and s.plane = 'media_stats'
         and s.subject_ref = d.subject_ref
         and s.media_shown_outside_dm_at is null
      returning s.page_id, s.last_visited_at, s.dirty_reason, d.headless
    )
    select d.page_id,
           p.label as page_label,
           count(*)::text as rows,
           count(*) filter (where d.last_visited_at is not null)::text as visited,
           count(*) filter (where d.dirty_reason is not null)::text as dirty,
           count(*) filter (where d.headless)::text as headless
      from deleted d
      join pages p on p.id = d.page_id
     group by d.page_id, p.label
     order by d.page_id
  `);
  return dmOnlyMediaStatsCounts(result.rows);
}
