import { sql } from "drizzle-orm";
import type { Database } from "../client.ts";

export interface VaultAlbumScanInput {
  pageId: number; albumRef: string; walkRef: string;
  startedAt: Date; completedAt: Date; seenMediaRefs: string[]; expectedCount: number; pages: number;
  sourceEventId: number; sourceObservationId: number; sourceAccountSeq: number;
}

/** Also used after a late historical member arrives, so replay order cannot
 * resurrect a member absent from a newer full walk. A sighting DURING or after
 * the walk wins over absence: provider pagination is not an atomic snapshot. */
export async function reconcileVaultAlbumScan(db: Database, pageId: number, albumRef: string, mediaRef?: string): Promise<void> {
  const missingSince = sql`case
    when m.last_observed_at >= s.started_at then null
    when m.media_ref = any(s.seen_media_refs) then null
    else coalesce(m.missing_since, s.completed_at) end`;
  await db.execute(sql`
    update creator_vault_album_members m
       set missing_since = ${missingSince}, updated_at = now()
      from creator_vault_album_scans s
     where s.page_id = ${pageId} and s.album_ref = ${albumRef} and s.vault_kind = 'creator'
       and m.page_id = s.page_id and m.vault_kind = s.vault_kind and m.album_ref = s.album_ref
       ${mediaRef === undefined ? sql`` : sql`and m.media_ref = ${mediaRef}`}
       and m.missing_since is distinct from (${missingSince})
  `);
}

export async function upsertVaultAlbumScan(db: Database, input: VaultAlbumScanInput): Promise<void> {
  const refs = sql`ARRAY[${sql.join(input.seenMediaRefs.map(ref => sql`${ref}`), sql`, `)}]::text[]`;
  const result = await db.execute(sql`
    insert into creator_vault_album_scans (
      page_id, vault_kind, album_ref, walk_ref, started_at, completed_at, seen_media_refs,
      expected_count, pages, source_event_id, source_observation_id, source_account_seq
    ) values (${input.pageId}, 'creator', ${input.albumRef}, ${input.walkRef}, ${input.startedAt},
      ${input.completedAt}, ${refs}, ${input.expectedCount}, ${input.pages},
      ${input.sourceEventId}, ${input.sourceObservationId}, ${input.sourceAccountSeq})
    on conflict (page_id, vault_kind, album_ref) do update set
      walk_ref = excluded.walk_ref, started_at = excluded.started_at, completed_at = excluded.completed_at,
      seen_media_refs = excluded.seen_media_refs, expected_count = excluded.expected_count,
      pages = excluded.pages, source_event_id = excluded.source_event_id,
      source_observation_id = excluded.source_observation_id, source_account_seq = excluded.source_account_seq,
      updated_at = now()
    where (excluded.completed_at, excluded.source_account_seq) >
      (creator_vault_album_scans.completed_at, creator_vault_album_scans.source_account_seq)
    returning album_ref
  `);
  if ((result.rowCount ?? 0) > 0) await reconcileVaultAlbumScan(db, input.pageId, input.albumRef);
}

/**
 * How many of these pages are serving a creator-vault inventory NO FULL WALK HAS
 * EVER PROVEN.
 *
 * An album is PROVEN when a scan row exists for its exact `(page, vault_kind,
 * album_ref)` with a `completed_at` and an `expected_count` equal to the roster
 * it actually saw — a walk that stopped short leaves a row whose counts disagree,
 * and that is not proof. A page is UNPROVEN when at least one LIVE creator album
 * (`vault_kind = 'creator'`, no `missing_since`) has no such row. Albums the
 * platform stopped naming are excluded: they are absent by evidence, and
 * demanding a fresh walk of them would make the blocker permanent.
 *
 * STALENESS IS DELIBERATELY NOT MEASURED (v1, decision #247). A walk completed a
 * year ago counts as proven; the per-album `lastFullWalkAt` already on every
 * `vault_media` row is where a reader judges age.
 */
export async function countPagesWithUnprovenCreatorVaultInventory(
  db: Database,
  pageIds: number[],
): Promise<number> {
  if (pageIds.length === 0) {
    return 0;
  }
  const ids = sql`(${sql.join(pageIds.map(id => sql`${id}`), sql`, `)})`;
  // ONE statement, and every column qualified: a bare name here would resolve
  // against the outer SELECT's alias list before the table's (the house trap).
  const result = await db.execute<{ count: string }>(sql`
    select count(distinct a.page_id)::text as count
      from creator_vault_albums a
      left join creator_vault_album_scans s
        on s.page_id = a.page_id
       and s.vault_kind = a.vault_kind
       and s.album_ref = a.album_ref
       and s.completed_at is not null
       and s.expected_count = cardinality(s.seen_media_refs)
     where a.page_id in ${ids}
       and a.vault_kind = 'creator'
       and a.missing_since is null
       and s.page_id is null
  `);
  return Number(result.rows[0]?.count ?? 0);
}
