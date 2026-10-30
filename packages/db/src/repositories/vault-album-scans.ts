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
 * STALENESS IS DELIBERATELY NOT MEASURED (v1). A walk completed a
 * year ago counts as proven; the per-album `lastFullWalkAt` already on every
 * `vault_media` row is where a reader judges age.
 */
/**
 * OnlyFans has no per-album walk record: its vault is read by `vault_catalog`
 * collection jobs. A page's OF inventory is proven when its LATEST such job
 * completed and walked the whole vault — an inventory step from offset 0 with
 * no narrowing query (the dashboard's `inventory.state = complete`, same rule).
 * A job that ran out of budget is `failed` and proves nothing.
 * Fixed SQL, no request value; also embedded verbatim by the vault_media dataset.
 */
export const OFAPI_PROVEN_VAULT_WALKS_SQL = `
  select latest.page_id, latest.id::text as walk_ref, latest.updated_at as completed_at
    from (
      select distinct on (j.page_id) j.page_id, j.id, j.state, j.checkpoint, j.updated_at
        from ofapi_collection_jobs j
       where j.category = 'vault_catalog'
       order by j.page_id, j.created_at desc
    ) latest
   where latest.state = 'completed'
     and exists (
       select 1
         from jsonb_array_elements(case when jsonb_typeof(latest.checkpoint->'plan') = 'array'
                                        then latest.checkpoint->'plan' else '[]'::jsonb end) as step(value)
        where step.value->>'operation' = 'ofapi_read_vault_inventory'
          and case when jsonb_typeof(step.value->'query') = 'object'
                   then coalesce(step.value->'query'->>'offset', '0') = '0'
                    and not exists (
                          select 1 from jsonb_object_keys(step.value->'query') as q(key)
                           where q.key not in ('limit', 'offset', 'sort', 'field'))
                   else false end
     )
`;

export async function countPagesWithUnprovenCreatorVaultInventory(
  db: Database,
  pageIds: number[],
): Promise<number> {
  if (pageIds.length === 0) {
    return 0;
  }
  // ONE statement, and every column qualified: a bare name here would resolve
  // against the outer SELECT's alias list before the table's (the house trap).
  // Fansly: two ways to be unproven, and the first is the one a join from the
  // albums table cannot see: a page with NO live creator album row at all has no
  // roster to check — the album listing was never captured or never projected
  // — and that is the least proven inventory there is, not a proven-empty one.
  // (Fansly always serves the creator's system albums, so an honestly empty
  // roster does not occur.) The second is a live album without a proving scan.
  // OnlyFans: no proven latest walk (OFAPI_PROVEN_VAULT_WALKS_SQL).
  const result = await db.execute<{ count: string }>(sql`
    select count(*)::text as count
      from unnest(array[${sql.join(pageIds.map(id => sql`${id}::bigint`), sql`, `)}]) as scope(page_id)
      left join pages p on p.id = scope.page_id
     where case when p.platform::text = 'onlyfans' then not exists (
             select 1 from (${sql.raw(OFAPI_PROVEN_VAULT_WALKS_SQL)}) w where w.page_id = scope.page_id
           ) else (
           not exists (
             select 1
               from creator_vault_albums a
              where a.page_id = scope.page_id
                and a.vault_kind = 'creator'
                and a.missing_since is null
           )
        or exists (
             select 1
               from creator_vault_albums a
               left join creator_vault_album_scans s
                 on s.page_id = a.page_id
                and s.vault_kind = a.vault_kind
                and s.album_ref = a.album_ref
                and s.completed_at is not null
                and s.expected_count = cardinality(s.seen_media_refs)
              where a.page_id = scope.page_id
                and a.vault_kind = 'creator'
                and a.missing_since is null
                and s.page_id is null
           )
           ) end
  `);
  return Number(result.rows[0]?.count ?? 0);
}
