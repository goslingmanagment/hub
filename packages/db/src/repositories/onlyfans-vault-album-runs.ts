import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The run of an OnlyFans vault album (0397, 8-docs 2026-11-12-of-vault-album,
// plan PR 4): what its executor (apps/runtime/src/services/
// publications-onlyfans-vault.ts) knows between its minutes. This file only
// stores it; every decision is the executor's.

export type OnlyfansVaultAlbumStep = "album" | "contents" | "uploads" | "add" | "read" | "done";

/**
 * One file of the album:
 * - `pending`: not worked on yet;
 * - `in_album`: the album already holds its media (nothing uploaded, nothing added);
 * - `reused`: the page's vault holds its bytes from Hub's earlier upload (read to be there): added by its id, not paid;
 * - `uploading`: its upload job is this run's current one;
 * - `uploaded`: its upload answered a media id;
 * - `failed`: refused for itself (OnlyFans/OnlyFansAPI said no, or nothing left);
 * - `unknown`: its upload may have gone (an answer lost, still processing after 90 minutes, an earlier upload unresolved): never sent again by itself;
 * - `too_big`: over what OnlyFansAPI takes: added by hand;
 * - `not_tried`: the uploads stopped before it.
 */
export type OnlyfansVaultFileState = "pending" | "in_album" | "reused" | "uploading" | "uploaded" | "failed" | "unknown" | "too_big" | "not_tried";

export interface OnlyfansVaultAlbumFile {
  /** `media:N` of the approval. */
  item: string;
  position: number;
  /** Hub's publication file; null for a vault media the draft named. */
  fileId: number | null;
  sha256: string | null;
  bytes: number;
  mimeType: string | null;
  /** The name the report gives it: the draft's, the file's own, or its item. */
  name: string;
  /** Its upload's price (3 credits a started MB), 0 when nothing is uploaded. */
  credits: number;
  state: OnlyfansVaultFileState;
  /** This run's upload job of it. */
  jobId: string | null;
  /** Its vault media id once known. */
  mediaRef: string | null;
  /** When its media came to the page (its upload's completion): the album orders old files by it. */
  uploadedAt: string | null;
  /** When this run started its upload. */
  startedAt: string | null;
  reason: string | null;
}

export interface OnlyfansVaultAlbumRun {
  publicationId: number;
  pageId: number;
  revisionId: number;
  step: OnlyfansVaultAlbumStep;
  albumRef: string | null;
  /** The album was there before this run (found by its title or named): its contents were read. */
  albumExisted: boolean;
  /** Fixed when the executor admitted the album; uploads stop past it by 10 %. */
  priceCredits: number;
  spentCredits: number;
  /** Credits of the run's own requests besides uploads (reads, the create, the add), by estimate. */
  actionCredits: number;
  stopReason: string | null;
  files: OnlyfansVaultAlbumFile[];
  notes: Record<string, unknown>;
  startedAt: Date;
  updatedAt: Date;
}

type Row = Record<string, unknown>;

function toRun(row: Row): OnlyfansVaultAlbumRun {
  return {
    publicationId: Number(row.publication_id),
    pageId: Number(row.page_id),
    revisionId: Number(row.revision_id),
    step: row.step as OnlyfansVaultAlbumStep,
    albumRef: (row.album_ref as string | null) ?? null,
    albumExisted: row.album_existed === true,
    priceCredits: Number(row.price_credits),
    spentCredits: Number(row.spent_credits),
    actionCredits: Number(row.action_credits),
    stopReason: (row.stop_reason as string | null) ?? null,
    files: (row.files as OnlyfansVaultAlbumFile[] | null) ?? [],
    notes: (row.notes as Record<string, unknown> | null) ?? {},
    startedAt: new Date(row.started_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

/** The run of an album as admitted; false when one exists already (another worker, a crash before). */
export async function insertOnlyfansVaultAlbumRun(db: Database, input: Pick<OnlyfansVaultAlbumRun, "publicationId" | "pageId" | "revisionId" | "priceCredits" | "files">): Promise<boolean> {
  const inserted = await db.execute<Row>(sql`
    insert into onlyfans_vault_album_runs (publication_id, page_id, revision_id, step, price_credits, files)
    values (${input.publicationId}, ${input.pageId}, ${input.revisionId}, 'album', ${input.priceCredits}, ${JSON.stringify(input.files)}::jsonb)
    on conflict (publication_id) do nothing
    returning publication_id
  `);
  return inserted.rows.length > 0;
}

export async function getOnlyfansVaultAlbumRun(db: Database, publicationId: number): Promise<OnlyfansVaultAlbumRun | null> {
  const result = await db.execute<Row>(sql`select * from onlyfans_vault_album_runs where publication_id = ${publicationId}`);
  const row = result.rows[0];
  return row ? toRun(row) : null;
}

/** Everything a step moved, written at once. */
export async function saveOnlyfansVaultAlbumRun(db: Database, run: Pick<OnlyfansVaultAlbumRun,
  "publicationId" | "step" | "albumRef" | "albumExisted" | "spentCredits" | "actionCredits" | "stopReason" | "files" | "notes">): Promise<void> {
  await db.execute(sql`
    update onlyfans_vault_album_runs set
      step = ${run.step},
      album_ref = ${run.albumRef},
      album_existed = ${run.albumExisted},
      spent_credits = ${run.spentCredits},
      action_credits = ${run.actionCredits},
      stop_reason = ${run.stopReason},
      files = ${JSON.stringify(run.files)}::jsonb,
      notes = ${JSON.stringify(run.notes)}::jsonb,
      updated_at = now()
     where publication_id = ${run.publicationId}
  `);
}

/** The albums running now (not done), whose publication is still being sent, oldest first. */
export async function listRunningOnlyfansVaultAlbumRuns(db: Database): Promise<OnlyfansVaultAlbumRun[]> {
  const result = await db.execute<Row>(sql`
    select r.* from onlyfans_vault_album_runs r
      join publications p on p.id = r.publication_id
     where r.step <> 'done' and p.status = 'submitting' and p.kind = 'vault_album'
     order by r.started_at, r.publication_id
  `);
  return result.rows.map(toRun);
}

/** Approved vault albums of OnlyFans pages whose time has come, earliest first; only `kind = 'vault_album'`. */
export async function listDueOnlyfansVaultAlbums(db: Database, now: Date): Promise<Array<{ id: number; pageId: number; publishAt: Date; statusReason: string | null }>> {
  const result = await db.execute<Row>(sql`
    select p.id, p.page_id, p.publish_at, p.status_reason
      from publications p
      join pages pg on pg.id = p.page_id
     where p.status = 'approved' and p.kind = 'vault_album' and pg.platform::text = 'onlyfans' and pg.status = 'active'
       and p.publish_at <= ${now}
     order by p.publish_at, p.id
  `);
  return result.rows.map((row) => ({
    id: Number(row.id), pageId: Number(row.page_id), publishAt: new Date(row.publish_at as string), statusReason: (row.status_reason as string | null) ?? null,
  }));
}

/** One vault upload Hub made for a page, as its job stands. */
export interface OnlyfansVaultUploadFacts {
  jobId: string;
  sha256: string;
  state: string;
  reasonCode: string | null;
  cursor: Record<string, unknown> | null;
  dispatchCount: number;
  maxCredits: number;
  completedAt: Date | null;
  createdAt: Date;
  /** The album publication the job was made for, when one. */
  publicationId: number | null;
}

/** Hub's vault uploads to the page of these bytes (by sha256), newest first. */
export async function listOnlyfansVaultUploadsOf(db: Database, pageId: number, sha256s: readonly string[]): Promise<OnlyfansVaultUploadFacts[]> {
  if (sha256s.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select id::text as id, target->>'sourceSha256' as sha256, state, reason_code, cursor, dispatch_count,
           coalesce((target->>'maxCredits')::int, 0) as max_credits, completed_at, created_at,
           (target->>'publicationId')::bigint as publication_id
      from ofapi_capture_jobs
     where kind = 'media_upload' and page_id = ${pageId} and target->>'destination' = 'vault'
       and target->>'sourceSha256' = any(${sql.param([...sha256s])}::text[])
     order by created_at desc, id desc
  `);
  return result.rows.map(toUpload);
}

/** Every upload job made for one album publication (its frozen target names it). */
export async function listOnlyfansVaultUploadsOfPublication(db: Database, publicationId: number): Promise<OnlyfansVaultUploadFacts[]> {
  const result = await db.execute<Row>(sql`
    select id::text as id, target->>'sourceSha256' as sha256, state, reason_code, cursor, dispatch_count,
           coalesce((target->>'maxCredits')::int, 0) as max_credits, completed_at, created_at,
           (target->>'publicationId')::bigint as publication_id
      from ofapi_capture_jobs
     where kind = 'media_upload' and target->>'destination' = 'vault' and target->>'publicationId' = ${String(publicationId)}
  `);
  return result.rows.map(toUpload);
}

/** One upload job by id, as `listOnlyfansVaultUploadsOf` reads it. */
export async function getOnlyfansVaultUpload(db: Database, jobId: string): Promise<OnlyfansVaultUploadFacts | null> {
  const result = await db.execute<Row>(sql`
    select id::text as id, target->>'sourceSha256' as sha256, state, reason_code, cursor, dispatch_count,
           coalesce((target->>'maxCredits')::int, 0) as max_credits, completed_at, created_at,
           (target->>'publicationId')::bigint as publication_id
      from ofapi_capture_jobs where id = ${jobId}::uuid and kind = 'media_upload'
  `);
  const row = result.rows[0];
  return row ? toUpload(row) : null;
}

function toUpload(row: Row): OnlyfansVaultUploadFacts {
  return {
    jobId: String(row.id),
    sha256: String(row.sha256 ?? ""),
    state: String(row.state),
    reasonCode: (row.reason_code as string | null) ?? null,
    cursor: (row.cursor as Record<string, unknown> | null) ?? null,
    dispatchCount: Number(row.dispatch_count ?? 0),
    maxCredits: Number(row.max_credits ?? 0),
    completedAt: row.completed_at === null || row.completed_at === undefined ? null : new Date(row.completed_at as string),
    createdAt: new Date(row.created_at as string),
    publicationId: row.publication_id === null || row.publication_id === undefined ? null : Number(row.publication_id),
  };
}

/**
 * Why an upload job stopped before anything left that no retry changes: its
 * request cannot be built, its bytes changed, the album let it go. Any other
 * stop of a job that never left (held by the album's switches, a budget
 * denial without a retry time, the binding or the egress down) may be tried
 * again: nothing was sent.
 */
export const ONLYFANS_VAULT_UPLOAD_FINAL_STOPS: readonly string[] = [
  "target_invalid", "media_source_unavailable", "lease_missing", "vault_album_abandoned", "unsupported_job_kind",
];

/** Nothing of the job is in flight or uncertain: no attempt reserved, dispatching or indeterminate. */
const neverLeft = (jobId: string) => sql`
  dispatch_count = 0 and cursor is null
  and not exists (select 1 from ofapi_request_attempts a where a.owner_kind = 'capture_job' and a.owner_id = ${jobId}::uuid
                    and a.state in ('reserved', 'dispatching', 'indeterminate'))`;

/**
 * An album upload stopped before its write that never left (held by the
 * album's own check, a budget denial, the binding): back to the sweep. A
 * job that dispatched once keeps its outcome; a final stop stays.
 */
export async function resumeUnsentOnlyfansVaultUpload(db: Database, jobId: string): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update ofapi_capture_jobs
       set state = 'ready', reason_code = null, reason_message = null, next_attempt_at = now(),
           row_version = row_version + 1, updated_at = now()
     where id = ${jobId}::uuid and kind = 'media_upload' and state = 'blocked'
       and reason_code <> all(${sql.param([...ONLYFANS_VAULT_UPLOAD_FINAL_STOPS])}::text[])
       and ${neverLeft(jobId)}
    returning id
  `);
  return result.rows.length > 0;
}

/**
 * An album upload the album no longer waits for and that never left (queued
 * or stopped, not leased, nothing dispatched): blocked for good, so the common
 * sweep never sends it later outside its album. False: it was leased or sent.
 */
export async function abandonUnsentOnlyfansVaultUpload(db: Database, jobId: string, reason: string): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update ofapi_capture_jobs
       set state = 'blocked', reason_code = 'vault_album_abandoned', reason_message = ${reason.slice(0, 300)},
           row_version = row_version + 1, updated_at = now()
     where id = ${jobId}::uuid and kind = 'media_upload' and state in ('ready', 'retry_wait', 'blocked')
       and ${neverLeft(jobId)}
    returning id
  `);
  return result.rows.length > 0;
}

/** The albums' account today and the last balance: what the admission weighs a price against. */
export async function readOnlyfansVaultCreditFacts(db: Database, now: Date): Promise<{ spentToday: number; balance: number | null; balanceAt: Date | null }> {
  const result = await db.execute<Row>(sql`
    select vault_album_spend_day, vault_album_spent_credits, last_balance, last_balance_at from ofapi_credit_state where id = 1
  `);
  const row = result.rows[0];
  const day = now.toISOString().slice(0, 10);
  const spendDay = row?.vault_album_spend_day === null || row?.vault_album_spend_day === undefined
    ? null
    : (row.vault_album_spend_day instanceof Date ? row.vault_album_spend_day.toISOString() : String(row.vault_album_spend_day)).slice(0, 10);
  return {
    spentToday: spendDay === day ? Number(row?.vault_album_spent_credits ?? 0) : 0,
    balance: row?.last_balance === null || row?.last_balance === undefined ? null : Number(row.last_balance),
    balanceAt: row?.last_balance_at === null || row?.last_balance_at === undefined ? null : new Date(row.last_balance_at as string),
  };
}
