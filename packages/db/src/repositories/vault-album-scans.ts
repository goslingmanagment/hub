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
export async function reconcileVaultAlbumScan(db: Database, pageId: number, albumRef: string): Promise<void> {
  await db.execute(sql`
    update creator_vault_album_members m
       set missing_since = case
         when m.media_ref = any(s.seen_media_refs) or m.last_observed_at >= s.started_at then null
         else coalesce(m.missing_since, s.completed_at) end
      from creator_vault_album_scans s
     where s.page_id = ${pageId} and s.album_ref = ${albumRef} and s.vault_kind = 'creator'
       and m.page_id = s.page_id and m.vault_kind = s.vault_kind and m.album_ref = s.album_ref
  `);
}

export async function upsertVaultAlbumScan(db: Database, input: VaultAlbumScanInput): Promise<void> {
  const refs = sql`ARRAY[${sql.join(input.seenMediaRefs.map(ref => sql`${ref}`), sql`, `)}]::text[]`;
  await db.execute(sql`
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
      source_observation_id = excluded.source_observation_id, source_account_seq = excluded.source_account_seq
    where (excluded.completed_at, excluded.source_account_seq) >
      (creator_vault_album_scans.completed_at, creator_vault_album_scans.source_account_seq)
  `);
  await reconcileVaultAlbumScan(db, input.pageId, input.albumRef);
}
