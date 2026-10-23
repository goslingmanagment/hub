import { sql } from "drizzle-orm";

import type { PublicationFileUse, PublicationStatus } from "@agency_hub_core/shared";

import type { Database } from "../client.ts";

// Files of publications (0297 identity, 0298 storage; docs/plans/2026-10-23-wall-posts
// PR 3). The bytes live on the server's disk, never here: these rows say
// which model a file belongs to, its sha256, size and type, when its bytes
// landed and when retention deleted them. Rows are never deleted — approved
// revisions name files by id and sha256. Every change to a file's bytes on
// disk happens while its row is locked FOR UPDATE (apps/runtime
// services/publication-files.ts holds that rule).

/** One advisory lock around the commit of an upload: the total-size check and the insert see one another. */
export const PUBLICATION_FILE_UPLOAD_LOCK_NAMESPACE = 58_231;

type Row = Record<string, unknown>;

function num(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error(`publication files: expected a safe integer, got ${String(value)}`);
  }
  return parsed;
}

function nullableNum(value: unknown): number | null {
  return value === null || value === undefined ? null : num(value);
}

function date(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function nullableDate(value: unknown): Date | null {
  return value === null || value === undefined ? null : date(value);
}

export interface PublicationFileRecord {
  id: number;
  modelId: number;
  modelSlug: string;
  contentSha256: string;
  byteSize: number | null;
  mimeType: string | null;
  originalName: string | null;
  createdByUserId: number | null;
  createdAt: Date;
  storedAt: Date;
  bytesDeletedAt: Date | null;
}

const FILE_COLUMNS = sql`
  f.id, f.model_id, m.slug as model_slug, f.content_sha256, f.byte_size, f.mime_type, f.original_name,
  f.created_by_user_id, f.created_at, f.stored_at, f.bytes_deleted_at
`;

function fileRecord(row: Row): PublicationFileRecord {
  return {
    id: num(row.id),
    modelId: num(row.model_id),
    modelSlug: String(row.model_slug),
    contentSha256: String(row.content_sha256),
    byteSize: nullableNum(row.byte_size),
    mimeType: (row.mime_type as string | null) ?? null,
    originalName: (row.original_name as string | null) ?? null,
    createdByUserId: nullableNum(row.created_by_user_id),
    createdAt: date(row.created_at),
    storedAt: date(row.stored_at),
    bytesDeletedAt: nullableDate(row.bytes_deleted_at),
  };
}

export interface PublicationFileModel {
  id: number;
  slug: string;
}

/** The model a file is uploaded for: by slug, by id, or a page's (an active page's) model. */
export async function findPublicationFileModel(
  db: Database,
  by: { slug: string } | { id: number } | { pageLabel: string },
): Promise<PublicationFileModel | null> {
  const result = await db.execute<Row>("slug" in by
    ? sql`select id, slug from models where slug = ${by.slug}`
    : "id" in by
      ? sql`select id, slug from models where id = ${by.id}`
      : sql`select m.id, m.slug from pages p join models m on m.id = p.model_id
             where p.label = ${by.pageLabel} and p.status = 'active'`);
  const row = result.rows[0];
  return row ? { id: num(row.id), slug: String(row.slug) } : null;
}

export async function getPublicationFile(db: Database, id: number): Promise<PublicationFileRecord | null> {
  const result = await db.execute<Row>(sql`
    select ${FILE_COLUMNS} from publication_files f join models m on m.id = f.model_id where f.id = ${id}
  `);
  const row = result.rows[0];
  return row ? fileRecord(row) : null;
}

export async function listPublicationFiles(db: Database, filter: {
  modelId: number | null;
  includeDeleted: boolean;
  limit: number;
}): Promise<PublicationFileRecord[]> {
  const result = await db.execute<Row>(sql`
    select ${FILE_COLUMNS} from publication_files f join models m on m.id = f.model_id
     where (${filter.modelId}::bigint is null or f.model_id = ${filter.modelId})
       and (${filter.includeDeleted}::boolean or f.bytes_deleted_at is null)
     order by f.stored_at desc, f.id desc
     limit ${filter.limit}
  `);
  return result.rows.map(fileRecord);
}

/** Take the upload commit lock (transaction-scoped). */
export async function lockPublicationFileUploads(db: Database): Promise<void> {
  await db.execute(sql`select pg_advisory_xact_lock(${PUBLICATION_FILE_UPLOAD_LOCK_NAMESPACE}, 0)`);
}

/** Bytes of every file whose bytes are on disk. */
export async function sumStoredPublicationFileBytes(db: Database): Promise<number> {
  const result = await db.execute<Row>(sql`
    select coalesce(sum(byte_size), 0)::bigint as total from publication_files where bytes_deleted_at is null
  `);
  return num(result.rows[0]?.total ?? 0);
}

/**
 * The model's file with these bytes, locked FOR UPDATE: the retention job
 * cannot delete its bytes, nor another upload restore them, until the
 * caller's transaction ends.
 */
export async function lockPublicationFileByContent(
  db: Database,
  input: { modelId: number; contentSha256: string },
): Promise<PublicationFileRecord | null> {
  const result = await db.execute<Row>(sql`
    select ${FILE_COLUMNS} from publication_files f join models m on m.id = f.model_id
     where f.model_id = ${input.modelId} and f.content_sha256 = ${input.contentSha256}
       for update of f
  `);
  const row = result.rows[0];
  return row ? fileRecord(row) : null;
}

/** The file by id, locked FOR UPDATE (the retention job's re-check before it deletes). */
export async function lockPublicationFile(db: Database, id: number): Promise<PublicationFileRecord | null> {
  const result = await db.execute<Row>(sql`
    select ${FILE_COLUMNS} from publication_files f join models m on m.id = f.model_id
     where f.id = ${id}
       for update of f
  `);
  const row = result.rows[0];
  return row ? fileRecord(row) : null;
}

/** A new file; null when the model already has these bytes (the caller locks and reuses that row). */
export async function insertPublicationFile(db: Database, input: {
  modelId: number;
  contentSha256: string;
  byteSize: number;
  mimeType: string;
  originalName: string | null;
  createdByUserId: number;
}): Promise<number | null> {
  const result = await db.execute<Row>(sql`
    insert into publication_files (model_id, content_sha256, byte_size, mime_type, original_name, created_by_user_id)
    values (${input.modelId}, ${input.contentSha256}, ${input.byteSize}, ${input.mimeType}, ${input.originalName},
            ${input.createdByUserId})
    on conflict (model_id, content_sha256) do nothing
    returning id
  `);
  const row = result.rows[0];
  return row ? num(row.id) : null;
}

/**
 * The same bytes uploaded again: they are on disk now (restored if retention
 * had deleted them), and the 7 days of an unused file start again.
 */
export async function markPublicationFileStored(db: Database, input: {
  id: number;
  byteSize: number;
  mimeType: string;
}): Promise<void> {
  await db.execute(sql`
    update publication_files
       set stored_at = now(), bytes_deleted_at = null,
           byte_size = ${input.byteSize}, mime_type = ${input.mimeType}
     where id = ${input.id}
  `);
}

/** Retention deleted the bytes; the row stays. Call with the row locked (lockPublicationFile). */
export async function markPublicationFileBytesDeleted(db: Database, id: number): Promise<void> {
  await db.execute(sql`update publication_files set bytes_deleted_at = now() where id = ${id} and bytes_deleted_at is null`);
}

export interface PublicationFileUseRecord extends PublicationFileUse {
  fileId: number;
  publicationId: number;
  pageLabel: string;
  publishAt: Date;
}

/** Every publication that names one of `fileIds` (as media or as a paid post's preview). */
export async function listPublicationFileUses(db: Database, fileIds: readonly number[]): Promise<PublicationFileUseRecord[]> {
  if (fileIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select distinct pm.file_id, p.id as publication_id, p.status, p.status_changed_at, p.publish_at, pg.label as page_label
      from publication_media pm
      join publications p on p.id = pm.publication_id
      join pages pg on pg.id = p.page_id
     where pm.file_id = any(${sql.param([...fileIds])}::bigint[])
     order by pm.file_id, p.id
  `);
  return result.rows.map((row) => ({
    fileId: num(row.file_id),
    publicationId: num(row.publication_id),
    status: String(row.status) as PublicationStatus,
    statusChangedAt: date(row.status_changed_at),
    publishAt: date(row.publish_at),
    pageLabel: String(row.page_label),
  }));
}

/** Files whose bytes are on disk, oldest landing first: the retention job's candidates. */
export async function listStoredPublicationFiles(db: Database, limit: number): Promise<PublicationFileRecord[]> {
  const result = await db.execute<Row>(sql`
    select ${FILE_COLUMNS} from publication_files f join models m on m.id = f.model_id
     where f.bytes_deleted_at is null
     order by f.stored_at, f.id
     limit ${limit}
  `);
  return result.rows.map(fileRecord);
}
