import { sql } from "drizzle-orm";

import type { Database } from "../client.ts";

// The write commands of a page's Fansly Sync Engine actor (0300, wall posts PR
// 6): one request Hub sends to Fansly inside a publication's dispatch. This
// file only reads and writes; the state machine — one attempt, the fingerprint
// before the send, never sent again after it may have gone — is the engine's
// (apps/runtime/src/sync/fansly/publish). Every transition here is a
// compare-and-set on the state it leaves, so two writers can never both move
// one row.

export const FANSLY_WRITE_STEPS = [
  "upload_create",
  // Wall posts PR 8 (0304): one part of an upload's bytes, and one read of
  // the upload's processing.
  "upload_part",
  "upload_complete",
  "upload_status",
  "account_media",
  "account_media_bundle",
  "post",
  "story",
  "post_cancel",
  // 0305: a published post deleted from the wall (the owner's, 2026-10-24).
  "post_delete",
  // 0323: a vault album created, and its media added to it in one request.
  "album_create",
  "album_media",
] as const;
export type FanslyWriteStep = (typeof FANSLY_WRITE_STEPS)[number];

export const FANSLY_WRITE_STATES = ["queued", "sending", "answered", "rejected", "unknown", "refused"] as const;
export type FanslyWriteState = (typeof FANSLY_WRITE_STATES)[number];

/** The ends a command never leaves. */
export const FANSLY_WRITE_FINAL_STATES: readonly FanslyWriteState[] = ["answered", "rejected", "unknown", "refused"];

export type FanslyWritePriority = "background" | "urgent";

/** What an admission sent, as recorded before the send. */
export interface FanslyWriteRequestRecord {
  spec: string;
  method: string;
  host: string;
  pathAndQuery: string;
  body: string;
  fingerprint: string;
  /** What the request was derived from: the approval, the file's sha256, the
   *  earlier commands whose results it carries. */
  facts?: unknown;
}

export interface FanslyWriteCommandRecord {
  id: number;
  pageId: number;
  dispatchId: number;
  publicationId: number;
  step: FanslyWriteStep;
  /** `media:<position>`, `preview:<position>` (an upload's part `…/part:<k>`,
   *  a read of its processing `…/poll:<k>`), or '' for the publication. */
  item: string;
  priority: FanslyWritePriority;
  notBefore: Date;
  notAfter: Date | null;
  state: FanslyWriteState;
  stateReason: string | null;
  workId: number | null;
  attemptId: number | null;
  notSentCount: number;
  request: FanslyWriteRequestRecord | null;
  requestFingerprint: string | null;
  result: Record<string, unknown> | null;
  httpStatus: number | null;
  observationId: number | null;
  createdAt: Date;
  admittedAt: Date | null;
  settledAt: Date | null;
}

type Row = Record<string, unknown>;

function num(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`fansly_write_commands: expected a safe integer, got ${String(value)}`);
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

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function toCommand(row: Row): FanslyWriteCommandRecord {
  return {
    id: num(row.id),
    pageId: num(row.page_id),
    dispatchId: num(row.dispatch_id),
    publicationId: num(row.publication_id),
    step: row.step as FanslyWriteStep,
    item: String(row.item ?? ""),
    priority: row.priority as FanslyWritePriority,
    notBefore: date(row.not_before),
    notAfter: nullableDate(row.not_after),
    state: row.state as FanslyWriteState,
    stateReason: (row.state_reason as string | null) ?? null,
    workId: nullableNum(row.work_id),
    attemptId: nullableNum(row.attempt_id),
    notSentCount: num(row.not_sent_count ?? 0),
    request: record(row.request) as FanslyWriteRequestRecord | null,
    requestFingerprint: (row.request_fingerprint as string | null) ?? null,
    result: record(row.result),
    httpStatus: nullableNum(row.http_status),
    observationId: nullableNum(row.observation_id),
    createdAt: date(row.created_at),
    admittedAt: nullableDate(row.admitted_at),
    settledAt: nullableDate(row.settled_at),
  };
}

export interface InsertFanslyWriteCommandInput {
  dispatchId: number;
  step: FanslyWriteStep;
  item: string;
  priority: FanslyWritePriority;
  notBefore: Date;
  notAfter: Date | null;
}

/**
 * Queue one request of a dispatch (its page and publication are the
 * dispatch's). Null when a row of the same dispatch, step and item that was
 * not refused exists: the request is queued, sent or settled already, and is
 * never queued twice.
 */
export async function insertFanslyWriteCommand(db: Database, input: InsertFanslyWriteCommandInput): Promise<FanslyWriteCommandRecord | null> {
  const inserted = await db.execute<Row>(sql`
    insert into fansly_write_commands (page_id, dispatch_id, publication_id, step, item, priority, not_before, not_after)
    select d.page_id, d.id, d.publication_id, ${input.step}, ${input.item}, ${input.priority}, ${input.notBefore}, ${input.notAfter}
      from publication_dispatches d
     where d.id = ${input.dispatchId} and d.platform = 'fansly'
    on conflict (dispatch_id, step, item) where state <> 'refused' do nothing
    returning *
  `);
  const row = inserted.rows[0];
  return row ? toCommand(row) : null;
}

/** The work row the engine runs the command under (set once, at enqueue). */
export async function setFanslyWriteCommandWork(db: Database, input: { id: number; workId: number }): Promise<void> {
  await db.execute(sql`
    update fansly_write_commands set work_id = ${input.workId}, updated_at = now()
     where id = ${input.id} and work_id is null
  `);
}

export async function getFanslyWriteCommand(
  db: Database,
  id: number,
  options: { forUpdate?: boolean } = {},
): Promise<FanslyWriteCommandRecord | null> {
  const result = await db.execute<Row>(options.forUpdate === true
    ? sql`select * from fansly_write_commands where id = ${id} for update`
    : sql`select * from fansly_write_commands where id = ${id}`);
  const row = result.rows[0];
  return row ? toCommand(row) : null;
}

/** Every command of a dispatch, oldest first: the recorded results of its
 *  earlier steps a later request is derived from. */
/** A file's bytes Hub already uploaded to a page's account: the media Fansly
 *  made of them, and the read that found it done. */
export interface FanslyUploadedMedia {
  sha256: string;
  mediaId: string;
  commandId: number;
}

/**
 * The media Fansly made of these bytes on this page before (the contract
 * §12.7): an upload's read that found it done, under any dispatch of the page,
 * its create naming the bytes. The newest per bytes. Bytes the account
 * already has may fail the upload's completion: they are reused instead.
 */
export async function listFanslyUploadedMedia(db: Database, pageId: number, sha256s: readonly string[]): Promise<FanslyUploadedMedia[]> {
  if (sha256s.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select distinct on (c.request->'facts'->>'fileSha256')
           c.request->'facts'->>'fileSha256' as sha256, s.result->>'mediaId' as media_id, s.id as command_id
      from fansly_write_commands s
      join fansly_write_commands c
        on c.dispatch_id = s.dispatch_id and c.step = 'upload_create'
       and left(s.item, length(c.item) + 6) = c.item || '/poll:'
     where s.page_id = ${pageId}
       and s.step = 'upload_status' and s.state = 'answered'
       and s.result->>'done' = 'true' and coalesce(s.result->>'mediaId', '') <> ''
       and c.request->'facts'->>'fileSha256' = any(${sql.param([...sha256s])}::text[])
     order by c.request->'facts'->>'fileSha256', s.id desc
  `);
  return result.rows.map((row) => ({ sha256: String(row.sha256), mediaId: String(row.media_id), commandId: Number(row.command_id) }));
}

export async function listFanslyWriteCommandsOfDispatch(db: Database, dispatchId: number): Promise<FanslyWriteCommandRecord[]> {
  const result = await db.execute<Row>(sql`
    select * from fansly_write_commands where dispatch_id = ${dispatchId} order by id
  `);
  return result.rows.map(toCommand);
}

/**
 * The admission (the engine's tx 1, beside its attempt row): `queued` →
 * `sending`, with the attempt and the request that is about to go — its
 * fingerprint written BEFORE the send. False: the row is not queued any more
 * (or never was): the admission must not go on.
 */
export async function admitFanslyWriteCommand(db: Database, input: {
  id: number;
  attemptId: number;
  workId: number;
  request: FanslyWriteRequestRecord;
}): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update fansly_write_commands
       set state = 'sending', state_reason = null, attempt_id = ${input.attemptId}, work_id = ${input.workId},
           request = ${JSON.stringify(input.request)}::jsonb, request_fingerprint = ${input.request.fingerprint},
           admitted_at = now(), updated_at = now()
     where id = ${input.id} and state = 'queued' and attempt_id is null
    returning id
  `);
  return result.rows.length > 0;
}

/**
 * The end of the command's one attempt: `sending` → `answered`, `rejected` or
 * `unknown`, for the attempt that admitted it and no other. False: it is not
 * that attempt's in flight (settled already, or another attempt's).
 */
export async function settleFanslyWriteCommand(db: Database, input: {
  id: number;
  attemptId: number;
  to: "answered" | "rejected" | "unknown";
  reason: string | null;
  result?: Record<string, unknown> | null;
  httpStatus?: number | null;
  observationId?: number | null;
}): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update fansly_write_commands
       set state = ${input.to}, state_reason = ${input.reason},
           result = ${input.result === undefined || input.result === null ? null : JSON.stringify(input.result)}::jsonb,
           http_status = ${input.httpStatus ?? null}, observation_id = ${input.observationId ?? null},
           settled_at = now(), updated_at = now()
     where id = ${input.id} and state = 'sending' and attempt_id = ${input.attemptId}
    returning id
  `);
  return result.rows.length > 0;
}

/**
 * The command's attempt provably never left (it ended aborted before the
 * send): `sending` → `queued`, its attempt let go. Nothing reached Fansly, so
 * this is no repeat of a send. False: not that attempt's in flight.
 */
export async function requeueFanslyWriteCommand(db: Database, input: { id: number; attemptId: number; reason: string }): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update fansly_write_commands
       set state = 'queued', state_reason = ${input.reason}, attempt_id = null, admitted_at = null,
           not_sent_count = not_sent_count + 1, updated_at = now()
     where id = ${input.id} and state = 'sending' and attempt_id = ${input.attemptId}
    returning id
  `);
  return result.rows.length > 0;
}

/** Never sent, and never will be: `queued` → `refused` with the reason. */
export async function refuseFanslyWriteCommand(db: Database, input: { id: number; reason: string }): Promise<boolean> {
  const result = await db.execute<Row>(sql`
    update fansly_write_commands
       set state = 'refused', state_reason = ${input.reason}, settled_at = now(), updated_at = now()
     where id = ${input.id} and state = 'queued'
    returning id
  `);
  return result.rows.length > 0;
}

/** What an upload of a publication's file sends: its bytes' identity, size,
 *  type and name (0297 `publication_files`). */
export interface FanslyWriteFileFacts {
  id: number;
  modelId: number;
  contentSha256: string;
  byteSize: number | null;
  mimeType: string | null;
  originalName: string | null;
  /** The bytes left the disk (0299 retention): nothing to upload. */
  bytesDeletedAt: Date | null;
}

export async function getFanslyWriteFileFacts(db: Database, fileIds: readonly number[]): Promise<FanslyWriteFileFacts[]> {
  if (fileIds.length === 0) return [];
  const result = await db.execute<Row>(sql`
    select id, model_id, content_sha256, byte_size, mime_type, original_name, bytes_deleted_at
      from publication_files where id = any(${sql.param([...fileIds])}::bigint[])
  `);
  return result.rows.map((row) => ({
    id: num(row.id),
    modelId: num(row.model_id),
    contentSha256: String(row.content_sha256),
    byteSize: nullableNum(row.byte_size),
    mimeType: (row.mime_type as string | null) ?? null,
    originalName: (row.original_name as string | null) ?? null,
    bytesDeletedAt: nullableDate(row.bytes_deleted_at),
  }));
}

/** The dispatch a command belongs to (0298): its publication, approval and kind. */
export interface FanslyWriteDispatchFacts {
  id: number;
  publicationId: number;
  pageId: number;
  revisionId: number;
  kind: "create" | "withdraw" | "delete";
  platform: string;
  mode: string;
}

export async function getFanslyWriteDispatch(db: Database, dispatchId: number): Promise<FanslyWriteDispatchFacts | null> {
  const result = await db.execute<Row>(sql`
    select id, publication_id, page_id, revision_id, kind, platform, mode
      from publication_dispatches where id = ${dispatchId}
  `);
  const row = result.rows[0];
  if (!row) return null;
  return {
    id: num(row.id),
    publicationId: num(row.publication_id),
    pageId: num(row.page_id),
    revisionId: num(row.revision_id),
    kind: row.kind as "create" | "withdraw" | "delete",
    platform: String(row.platform),
    mode: String(row.mode),
  };
}

/** What a write of a page reads of its walls and tiers (the contract §3–§4):
 *  the mandatory "Posts" wall (`main_wall`) and the tiers' names — as Hub
 *  collected them, still on the page. */
export interface FanslyWritePageFacts {
  mainWallRefs: string[];
  tierNames: Map<string, string>;
}

export async function getFanslyWritePageFacts(db: Database, pageId: number): Promise<FanslyWritePageFacts> {
  const [walls, tiers] = await Promise.all([
    db.execute<Row>(sql`
      select wall_ref from page_walls
       where page_id = ${pageId} and main_wall is true and missing_since is null
       order by wall_ref
    `),
    db.execute<Row>(sql`
      select tier_ref, name from page_subscription_tiers
       where page_id = ${pageId} and missing_since is null and name is not null
    `),
  ]);
  return {
    mainWallRefs: walls.rows.map((row) => String(row.wall_ref)),
    tierNames: new Map(tiers.rows.map((row) => [String(row.tier_ref), String(row.name)])),
  };
}
