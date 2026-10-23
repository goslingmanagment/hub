import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { PassThrough, Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { sql } from "drizzle-orm";

import type { PublicationFileWire } from "@agency_hub_core/contracts";
import {
  findPublicationFileModel,
  getPublicationFile,
  insertPublicationFile,
  listPublicationFileUses,
  listPublicationFiles,
  listStoredPublicationFiles,
  lockPublicationFile,
  lockPublicationFileByContent,
  lockPublicationFileUploads,
  markPublicationFileBytesDeleted,
  markPublicationFileStored,
  sumStoredPublicationFileBytes,
  type Database,
  type PublicationFileRecord,
  type PublicationFileUseRecord,
} from "@agency_hub_core/db";
import {
  detectPublicationFileMime,
  isPublicationFileDue,
  PUBLICATION_FILE_MAX_MB_DEFAULT,
  PUBLICATION_FILE_SNIFF_BYTES,
  PUBLICATION_FILES_MAX_TOTAL_GB_DEFAULT,
  publicationFileLimitBytes,
  publicationFileRetainUntil,
  publicationFileUploadRefusal,
  type AppConfig,
  type PublicationFileMimeType,
} from "@agency_hub_core/shared";

import type { AppContext } from "../bootstrap.ts";
import { loadEffectiveConfig } from "./effective-config.ts";
import { AppError, BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { ensureQueueCreated, type QueueCreationClient } from "./sync-queue.ts";

// Files of publications (docs/plans/2026-10-23-wall-posts, spec §7, plan PR 3).
//
// The bytes live on the server's disk under PUBLICATION_FILES_DIR, never in
// Postgres and never in observations: collected facts are never deleted on a
// schedule, these must be. Layout, content-addressed per model:
//
//   <root>/<model_id>/<sha256>      the bytes of one file (no extension)
//   <root>/.incoming/<uuid>.part    an upload still streaming in
//
// Rules this file holds:
// 1. An upload streams into .incoming while its sha256, size and type are
//    computed (the type from the first bytes; a larger file than the limit is
//    cut off while it streams), then is renamed into place under one upload
//    lock with the total-size check. The same bytes for the same model are the
//    same row (0297 unique key).
// 2. Every change to a file's bytes on disk — the rename of an upload, the
//    deletion by retention — happens while its row is locked FOR UPDATE, and
//    the deletion happens inside the transaction that marks the row. So a new
//    upload of the same bytes and the deletion cannot cross.
// 3. Retention (spec §7): bytes stay while any publication that uses the file
//    is not finished, and 7 days after the last one finished; a file no
//    publication used goes 7 days after its upload
//    (@agency_hub_core/shared publication-files.ts). The FOR UPDATE row lock
//    also waits for a draft being saved with the file: its foreign key holds
//    FOR KEY SHARE on the row until it commits, and the job then re-reads the
//    uses. A draft that lands after the deletion carries the blocking finding
//    `file_deleted` (services/publications.ts) until the file is uploaded
//    again. Only our own upload cache is deleted; the rows stay, because
//    approved revisions name files by id and sha256.

const INCOMING_DIR = ".incoming";
/** An upload left in .incoming longer than this was cut off by a crash or restart. */
const INCOMING_STALE_MS = 24 * 60 * 60 * 1000;
/** How many kept files one retention pass looks at. */
const RETENTION_BATCH = 1000;
const SHA256 = /^[0-9a-f]{64}$/;

export const PUBLICATION_FILES_RETENTION_QUEUE = "publications.files.retention";

/** 413 / 415 / 507 with the machine code the dashboard branches on. */
export class PublicationFileRefusedError extends AppError {
  constructor(message: string, statusCode: 413 | 415 | 507, code: "publication_file_too_large" | "publication_file_type" | "publication_files_full") {
    super(message, statusCode, code);
  }
}

export function publicationFilesRoot(config: Pick<AppConfig, "publicationFilesDir">): string {
  return path.resolve(config.publicationFilesDir ?? "publication-files");
}

/** Where one file's bytes are. Only ever under `root`: the id is a number, the sha256 is checked. */
export function publicationFilePath(root: string, file: { modelId: number; contentSha256: string }): string {
  if (!Number.isSafeInteger(file.modelId) || file.modelId <= 0 || !SHA256.test(file.contentSha256)) {
    throw new Error("publication file: model id or sha256 is malformed");
  }
  return path.join(root, String(file.modelId), file.contentSha256);
}

function limitsOf(config: AppConfig) {
  return publicationFileLimitBytes({
    fileMaxMb: config.publicationFileMaxMb ?? PUBLICATION_FILE_MAX_MB_DEFAULT,
    totalMaxGb: config.publicationFilesMaxTotalGb ?? PUBLICATION_FILES_MAX_TOTAL_GB_DEFAULT,
  });
}

/** A person's file name, kept for people only: no control characters or path separators, at most 200 characters. */
export function cleanPublicationFileName(name: string | undefined | null): string | null {
  if (name === undefined || name === null) return null;
  const cleaned = Array.from(name, (char) => (char.charCodeAt(0) < 32 || char === "/" || char === "\\" ? "_" : char))
    .join("")
    .trim()
    .slice(0, 200);
  return cleaned === "" ? null : cleaned;
}

// ---------------------------------------------------------------------------
// Wire
// ---------------------------------------------------------------------------

function toPublicationFileWire(file: PublicationFileRecord, uses: readonly PublicationFileUseRecord[]): PublicationFileWire {
  const retainUntil = file.bytesDeletedAt === null ? publicationFileRetainUntil({ storedAt: file.storedAt, uses }) : null;
  return {
    id: file.id,
    modelId: file.modelId,
    modelSlug: file.modelSlug,
    sha256: file.contentSha256,
    byteSize: file.byteSize,
    mimeType: file.mimeType,
    originalName: file.originalName,
    createdByUserId: file.createdByUserId,
    createdAt: file.createdAt.toISOString(),
    storedAt: file.storedAt.toISOString(),
    stored: file.bytesDeletedAt === null,
    bytesDeletedAt: file.bytesDeletedAt?.toISOString() ?? null,
    retainUntil: retainUntil?.toISOString() ?? null,
    uses: uses.map((use) => ({
      publicationId: use.publicationId,
      pageLabel: use.pageLabel,
      status: use.status,
      publishAt: use.publishAt.toISOString(),
      statusChangedAt: use.statusChangedAt.toISOString(),
    })),
  };
}

function usesByFile(uses: readonly PublicationFileUseRecord[]): Map<number, PublicationFileUseRecord[]> {
  const out = new Map<number, PublicationFileUseRecord[]>();
  for (const use of uses) {
    const list = out.get(use.fileId) ?? [];
    list.push(use);
    out.set(use.fileId, list);
  }
  return out;
}

export async function getPublicationFileWire(db: Database, id: number): Promise<PublicationFileWire> {
  const file = await getPublicationFile(db, id);
  if (!file) throw new NotFoundError("File not found");
  return toPublicationFileWire(file, await listPublicationFileUses(db, [id]));
}

export async function listPublicationFilesWire(app: Pick<AppContext, "db" | "config">, filter: {
  modelSlug?: string | undefined;
  includeDeleted: boolean;
  limit: number;
}) {
  let modelId: number | null = null;
  if (filter.modelSlug !== undefined) {
    const model = await findPublicationFileModel(app.db, { slug: filter.modelSlug });
    if (!model) throw new NotFoundError("Model not found");
    modelId = model.id;
  }
  const [files, storedTotalBytes, effective] = await Promise.all([
    listPublicationFiles(app.db, { modelId, includeDeleted: filter.includeDeleted, limit: filter.limit }),
    sumStoredPublicationFileBytes(app.db),
    loadEffectiveConfig(app.db, app.config),
  ]);
  const uses = usesByFile(await listPublicationFileUses(app.db, files.map((file) => file.id)));
  const { fileMaxBytes, totalMaxBytes } = limitsOf(effective);
  return {
    files: files.map((file) => toPublicationFileWire(file, uses.get(file.id) ?? [])),
    storedTotalBytes,
    fileMaxBytes,
    totalMaxBytes,
  };
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export type PublicationFileModelSelector = { slug: string } | { id: number } | { pageLabel: string };

interface StreamedFile {
  tempPath: string;
  sha256: string;
  byteSize: number;
  mimeType: PublicationFileMimeType;
}

/**
 * The request body behind a stream of its own: a refusal mid-way destroys this
 * one and leaves the request alone (it is only unpiped), so the socket stays
 * open for the 413/415 answer, which then closes the connection. A client that
 * goes away ends it with an error instead of leaving it waiting.
 */
function detachedSource(body: Readable): Readable {
  const source = new PassThrough();
  let ended = false;
  body.once("end", () => {
    ended = true;
  });
  body.once("error", (error) => source.destroy(error));
  body.once("close", () => {
    if (!ended) source.destroy(new Error("the upload was cut off"));
  });
  body.pipe(source);
  return source;
}

/**
 * Stream `body` into .incoming: sha256 and size as it goes, the type from the
 * first bytes (refused at once when it is not one Hub publishes), cut off past
 * `maxBytes`. The temp file is removed on any failure.
 */
async function streamToIncoming(root: string, body: Readable, maxBytes: number): Promise<StreamedFile> {
  const incoming = path.join(root, INCOMING_DIR);
  await mkdir(incoming, { recursive: true });
  const tempPath = path.join(incoming, `${randomUUID()}.part`);
  const hash = createHash("sha256");
  let byteSize = 0;
  let head = Buffer.alloc(0);
  let mimeType: PublicationFileMimeType | null = null;
  const typeRefusal = () => new PublicationFileRefusedError(
    "Choose a JPEG, PNG, GIF, WebP, MP4, MOV or WebM file", 415, "publication_file_type",
  );
  const meter = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      byteSize += chunk.length;
      if (byteSize > maxBytes) {
        callback(new PublicationFileRefusedError(
          `The file is larger than the limit of ${Math.floor(maxBytes / 1_000_000)} MB`, 413, "publication_file_too_large",
        ));
        return;
      }
      if (mimeType === null && head.length < PUBLICATION_FILE_SNIFF_BYTES) {
        head = Buffer.concat([head, chunk.subarray(0, PUBLICATION_FILE_SNIFF_BYTES - head.length)]);
        if (head.length >= PUBLICATION_FILE_SNIFF_BYTES) {
          mimeType = detectPublicationFileMime(head);
          if (mimeType === null) {
            callback(typeRefusal());
            return;
          }
        }
      }
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(detachedSource(body), meter, createWriteStream(tempPath, { flags: "wx" }));
    if (byteSize === 0) throw new BadRequestError("The file is empty");
    mimeType ??= detectPublicationFileMime(head);
    if (mimeType === null) throw typeRefusal();
    // The bytes reach the disk before the row says they are there.
    const handle = await open(tempPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
    return { tempPath, sha256: hash.digest("hex"), byteSize, mimeType };
  } catch (error) {
    await rm(tempPath, { force: true });
    if (error instanceof AppError) throw error;
    // The client went away or the stream broke: nothing was stored.
    throw new BadRequestError("The upload did not arrive whole; send it again");
  }
}

async function fileOnDisk(filePath: string, byteSize: number | null): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && (byteSize === null || info.size === byteSize);
  } catch {
    return false;
  }
}

/**
 * The owner uploads one photo or video for a model (spec §7). Returns the
 * file; `created` is false when the model already had these bytes — the same
 * id answers, its bytes are restored if retention had deleted them, and its
 * 7 days start again.
 */
export async function uploadPublicationFile(app: Pick<AppContext, "db" | "config">, input: {
  body: Readable;
  /** The request's Content-Length, when it sent one: a file over the limit is refused before a byte is read. */
  declaredLength: number | null;
  model: PublicationFileModelSelector;
  originalName: string | null;
  userId: number;
}): Promise<{ file: PublicationFileWire; created: boolean }> {
  const model = await findPublicationFileModel(app.db, input.model);
  if (!model) throw new NotFoundError("pageLabel" in input.model ? "Page not found" : "Model not found");
  const effective = await loadEffectiveConfig(app.db, app.config);
  const { fileMaxBytes, totalMaxBytes } = limitsOf(effective);
  if (input.declaredLength !== null && input.declaredLength > fileMaxBytes) {
    throw new PublicationFileRefusedError(
      `The file is larger than the limit of ${Math.floor(fileMaxBytes / 1_000_000)} MB`, 413, "publication_file_too_large",
    );
  }
  const root = publicationFilesRoot(app.config);
  const streamed = await streamToIncoming(root, input.body, fileMaxBytes);
  const finalPath = publicationFilePath(root, { modelId: model.id, contentSha256: streamed.sha256 });
  let placedNew = false;
  try {
    const result = await app.db.transaction(async (rawTx) => {
      const tx = rawTx as unknown as Database;
      await lockPublicationFileUploads(tx);
      const existing = await lockPublicationFileByContent(tx, { modelId: model.id, contentSha256: streamed.sha256 });
      const alreadyStored = existing !== null && existing.bytesDeletedAt === null
        && await fileOnDisk(finalPath, existing.byteSize);
      const refusal = publicationFileUploadRefusal({
        byteSize: streamed.byteSize,
        alreadyStored,
        storedTotalBytes: await sumStoredPublicationFileBytes(tx),
        fileMaxBytes,
        totalMaxBytes,
      });
      if (refusal === "file_too_large") {
        throw new PublicationFileRefusedError("The file is larger than the limit", 413, "publication_file_too_large");
      }
      if (refusal === "storage_full") {
        throw new PublicationFileRefusedError(
          `Kept files would pass the limit of ${Math.floor(totalMaxBytes / 1_000_000_000)} GB; files of finished posts go 7 days after`,
          507, "publication_files_full",
        );
      }
      if (!alreadyStored) {
        await mkdir(path.dirname(finalPath), { recursive: true });
        await rename(streamed.tempPath, finalPath);
        placedNew = true;
      }
      if (existing) {
        await markPublicationFileStored(tx, { id: existing.id, byteSize: streamed.byteSize, mimeType: streamed.mimeType });
        return { id: existing.id, created: false };
      }
      const id = await insertPublicationFile(tx, {
        modelId: model.id,
        contentSha256: streamed.sha256,
        byteSize: streamed.byteSize,
        mimeType: streamed.mimeType,
        originalName: cleanPublicationFileName(input.originalName),
        createdByUserId: input.userId,
      });
      // Every insert takes the upload lock first, so the key cannot be taken in between.
      if (id === null) throw new ConflictError("The file was uploaded at the same moment; send it again");
      return { id, created: true };
    });
    return { file: await getPublicationFileWire(app.db, result.id), created: result.created };
  } catch (error) {
    // The row did not commit: bytes this upload placed have no row saying they are kept.
    if (placedNew) await rm(finalPath, { force: true });
    throw error;
  } finally {
    await rm(streamed.tempPath, { force: true });
  }
}

// ---------------------------------------------------------------------------
// Reading the bytes (Hub itself: OnlyFansAPI upload in plan PR 4b, the page
// browser in PR 8)
// ---------------------------------------------------------------------------

export interface PublicationFileOnDisk {
  file: PublicationFileRecord;
  path: string;
  byteSize: number;
  mimeType: string;
}

/**
 * Where a file's bytes are, for Hub to stream them (plan PR 8 serves them to
 * the page browser). Refuses a file whose bytes retention deleted or that is
 * not on disk with its recorded size.
 */
export async function openPublicationFile(app: Pick<AppContext, "db" | "config">, fileId: number): Promise<PublicationFileOnDisk> {
  const file = await getPublicationFile(app.db, fileId);
  if (!file) throw new NotFoundError("File not found");
  if (file.bytesDeletedAt !== null) {
    throw new ConflictError(`File ${fileId} was deleted after its 7 days; upload it again`);
  }
  if (file.byteSize === null || file.mimeType === null) {
    throw new ConflictError(`File ${fileId} has no stored bytes`);
  }
  const filePath = publicationFilePath(publicationFilesRoot(app.config), file);
  if (!await fileOnDisk(filePath, file.byteSize)) {
    throw new ConflictError(`File ${fileId} is missing on disk or has another size`);
  }
  return { file, path: filePath, byteSize: file.byteSize, mimeType: file.mimeType };
}

/**
 * The whole file in memory, its sha256 checked against the row: what
 * OnlyFansAPI's uploader takes (services/ofapi-media-uploads.ts builds its
 * multipart body from a Buffer, at most OFAPI_UPLOAD_MAX_BYTES).
 */
export async function readPublicationFileBytes(
  app: Pick<AppContext, "db" | "config">,
  fileId: number,
  options: { maxBytes: number },
): Promise<{ file: PublicationFileRecord; bytes: Buffer; mimeType: string }> {
  const onDisk = await openPublicationFile(app, fileId);
  if (onDisk.byteSize > options.maxBytes) {
    throw new ConflictError(`File ${fileId} is larger than ${options.maxBytes} bytes`);
  }
  const bytes = await readFile(onDisk.path);
  if (bytes.length !== onDisk.byteSize || createHash("sha256").update(bytes).digest("hex") !== onDisk.file.contentSha256) {
    throw new ConflictError(`File ${fileId} on disk is not the bytes that were uploaded`);
  }
  return { file: onDisk.file, bytes, mimeType: onDisk.mimeType };
}

// ---------------------------------------------------------------------------
// Retention (spec §7)
// ---------------------------------------------------------------------------

export interface PublicationFileRetentionSummary {
  checked: number;
  deleted: number;
  freedBytes: number;
  incomingRemoved: number;
  failed: number;
}

/**
 * Delete the bytes of files that are due (rule 3 above) and mark their rows;
 * then clear uploads a crash left in .incoming. Each file is decided again
 * under its row lock, in its own transaction.
 */
export async function runPublicationFileRetention(
  app: Pick<AppContext, "db" | "config" | "logger">,
  now: Date = new Date(),
): Promise<PublicationFileRetentionSummary> {
  const root = publicationFilesRoot(app.config);
  const summary: PublicationFileRetentionSummary = { checked: 0, deleted: 0, freedBytes: 0, incomingRemoved: 0, failed: 0 };
  const candidates = await listStoredPublicationFiles(app.db, RETENTION_BATCH);
  const uses = usesByFile(await listPublicationFileUses(app.db, candidates.map((file) => file.id)));
  summary.checked = candidates.length;
  for (const candidate of candidates) {
    if (!isPublicationFileDue({ storedAt: candidate.storedAt, uses: uses.get(candidate.id) ?? [] }, now)) continue;
    try {
      const freed = await app.db.transaction(async (rawTx) => {
        const tx = rawTx as unknown as Database;
        await tx.execute(sql`set local lock_timeout = '5s'`);
        // FOR UPDATE, not the UPDATE's own lock: it also waits for a draft whose
        // insert references this file (its foreign key holds FOR KEY SHARE).
        const file = await lockPublicationFile(tx, candidate.id);
        if (!file || file.bytesDeletedAt !== null) return null;
        const fresh = await listPublicationFileUses(tx, [file.id]);
        if (!isPublicationFileDue({ storedAt: file.storedAt, uses: fresh }, now)) return null;
        // Inside the lock and before the commit: a new upload of these bytes
        // waits for this transaction and then restores them.
        await rm(publicationFilePath(root, file), { force: true });
        await markPublicationFileBytesDeleted(tx, file.id);
        return file.byteSize ?? 0;
      });
      if (freed !== null) {
        summary.deleted += 1;
        summary.freedBytes += freed;
      }
    } catch (error) {
      summary.failed += 1;
      app.logger.warn({ err: error, fileId: candidate.id }, "Publication file retention skipped a file; the next pass tries again");
    }
  }
  summary.incomingRemoved = await clearStaleIncoming(root, now);
  return summary;
}

async function clearStaleIncoming(root: string, now: Date): Promise<number> {
  const incoming = path.join(root, INCOMING_DIR);
  let names: string[];
  try {
    names = await readdir(incoming);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!name.endsWith(".part")) continue;
    const entry = path.join(incoming, name);
    try {
      const info = await stat(entry);
      if (now.getTime() - info.mtimeMs < INCOMING_STALE_MS) continue;
      await rm(entry, { force: true });
      removed += 1;
    } catch {
      // Gone already, or finished by its upload in between.
    }
  }
  return removed;
}

export async function ensurePublicationFilesRetentionQueue(boss: QueueCreationClient, createdQueues?: Set<string>) {
  await ensureQueueCreated(boss, PUBLICATION_FILES_RETENTION_QUEUE, { policy: "exclusive" }, createdQueues);
}

/** Hourly, off the hour. The 7 days need no finer clock. */
export async function ensurePublicationFilesRetentionSchedule(boss: QueueCreationClient) {
  await boss.schedule?.(PUBLICATION_FILES_RETENTION_QUEUE, "23 * * * *", null, { tz: "UTC" });
}
