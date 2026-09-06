import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  createOfapiCollectionJob,
  createOrGetOfapiCaptureJob,
  findPageById,
  getOfapiCaptureJob,
  hashOfapiCaptureValue,
  insertAuditEvent,
  insertObservation,
  findObservationEnvelopesByIds,
  type Database,
} from "@agency_hub_core/db";
import type { z } from "zod";
import type {
  ofapiMediaSourceSchema,
  ofapiMediaUploadSchema,
} from "@agency_hub_core/contracts";
import type { AppContext } from "../bootstrap.ts";
import { resolveCapturePayloadRow } from "./payload-reader.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
export const OFAPI_UPLOAD_MAX_BYTES = 100_000_000;
interface Source extends Record<string, unknown> {
  id: string;
  page_id: number;
  account_id: string;
  sha256: string;
  byte_size: string;
  filename: string;
  mime_type: string;
  observation_id: string;
  observation_received_at: Date;
}
export function detectOfapiUploadMime(bytes: Buffer) {
  if (bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255])))
    return "image/jpeg";
  if (
    bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  )
    return "image/png";
  if (["GIF87a", "GIF89a"].includes(bytes.subarray(0, 6).toString()))
    return "image/gif";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WEBP"
  )
    return "image/webp";
  if (
    bytes.subarray(0, 4).toString() === "RIFF" &&
    bytes.subarray(8, 12).toString() === "WAVE"
  )
    return "audio/wav";
  if (bytes.subarray(4, 8).toString() === "ftyp" && bytes.length >= 16)
    return bytes.subarray(8, 12).toString().startsWith("M4A")
      ? "audio/mp4"
      : "video/mp4";
  if (bytes.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])))
    return "video/webm";
  if (
    bytes.subarray(0, 3).toString() === "ID3" ||
    (bytes[0] === 255 && bytes[1] !== undefined && (bytes[1] & 224) === 224)
  )
    return "audio/mpeg";
  throw new BadRequestError(
    "Choose a supported JPEG, PNG, GIF, WebP, MP4, WebM, MP3 or WAV file",
  );
}
export async function requireOfapiMediaSource(
  app: Pick<AppContext, "db">,
  sourceId: string,
  pageId: number,
) {
  const row = (
    await app.db.execute<Source>(
      sql`select * from ofapi_media_sources where id=${sourceId}::uuid and page_id=${pageId}`,
    )
  ).rows[0];
  if (!row)
    throw new NotFoundError("Owned media source not found for this page");
  const page = await findPageById(app.db, pageId);
  if (page?.page.ofapiAccountId !== row.account_id)
    throw new ConflictError(
      "Media source belongs to a different account binding",
    );
  return row;
}
function sourceDto(row: Source) {
  return {
    id: row.id,
    pageId: Number(row.page_id),
    filename: row.filename,
    mimeType: row.mime_type,
    bytes: Number(row.byte_size),
    sha256: row.sha256,
  };
}
export async function captureOwnerOfapiMediaSource(
  app: AppContext,
  input: z.infer<typeof ofapiMediaSourceSchema>,
  actorUserId: number,
) {
  const page = await findPageById(app.db, input.pageId);
  if (!page?.page.ofapiAccountId)
    throw new NotFoundError("Mapped OnlyFans page not found");
  const bytes = Buffer.from(input.fileBase64, "base64");
  if (bytes.toString("base64") !== input.fileBase64)
    throw new BadRequestError("File must be canonical base64");
  if (!bytes.length || bytes.length > OFAPI_UPLOAD_MAX_BYTES)
    throw new BadRequestError("Direct uploads are bounded to 100 decimal MB");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== input.expectedSha256)
    throw new BadRequestError("File checksum mismatch");
  const mimeType = detectOfapiUploadMime(bytes),
    filename = Array.from(input.filename, (char) =>
      char.charCodeAt(0) < 32 || char === "/" || char === "\\" ? "_" : char,
    )
      .join("")
      .slice(0, 200);
  const captured = await insertObservation(app.db, {
    source: "operator",
    producer: "ofapi-owned-media-source",
    platform: "onlyfans",
    accountId: input.pageId,
    nativeAccountRef: page.page.ofapiAccountId,
    kind: "ofapi.media_source.v1",
    payload: {
      sha256,
      bytes: bytes.length,
      filename,
      mimeType,
      encoding: "base64",
      body: input.fileBase64,
    },
    payloadHash: Buffer.from(sha256, "hex"),
    idempotencyKey: `ofapi-source:${input.pageId}:${page.page.ofapiAccountId}:${sha256}`,
    actorPrincipalId: actorUserId,
    observedAt: new Date(),
  });
  await app.db
    .execute(sql`insert into ofapi_media_sources(id,page_id,account_id,sha256,byte_size,filename,mime_type,observation_id,observation_received_at,actor_user_id)
 values(${randomUUID()}::uuid,${input.pageId},${page.page.ofapiAccountId},${sha256},${bytes.length},${filename},${mimeType},${captured.observationId},${captured.receivedAt},${actorUserId}) on conflict(page_id,account_id,sha256) do nothing`);
  const row = (
    await app.db.execute<Source>(
      sql`select * from ofapi_media_sources where page_id=${input.pageId} and account_id=${page.page.ofapiAccountId} and sha256=${sha256}`,
    )
  ).rows[0]!;
  return sourceDto(row);
}
export async function loadOfapiMediaSourceBytes(
  app: AppContext,
  sourceId: string,
  pageId: number,
) {
  const source = await requireOfapiMediaSource(app, sourceId, pageId);
  const row = (
    await findObservationEnvelopesByIds(app.db, [Number(source.observation_id)])
  ).get(Number(source.observation_id));
  if (!row || row.kind !== "ofapi.media_source.v1" || row.source !== "operator")
    throw new ConflictError("Retained source bytes unavailable");
  const resolved = await resolveCapturePayloadRow(
    app,
    "observation",
    Number(source.observation_id),
    row,
  );
  const payload = resolved.payload as Record<string, unknown>;
  if (payload.encoding !== "base64" || typeof payload.body !== "string")
    throw new ConflictError("Retained source envelope changed");
  const bytes = Buffer.from(payload.body, "base64");
  if (
    bytes.length !== Number(source.byte_size) ||
    createHash("sha256").update(bytes).digest("hex") !== source.sha256 ||
    detectOfapiUploadMime(bytes) !== source.mime_type
  )
    throw new ConflictError("Retained source checksum, size or type changed");
  return { source, bytes };
}
export async function createOwnerOfapiMediaUpload(
  app: AppContext,
  input: z.infer<typeof ofapiMediaUploadSchema>,
  actorUserId: number,
) {
  const source = await requireOfapiMediaSource(
    app,
    input.sourceId,
    input.pageId,
  );
  const estimatedCredits = Math.max(
    1,
    Math.ceil((Number(source.byte_size) * 3) / 1_000_000),
  );
  if (input.maxCredits < estimatedCredits)
    throw new BadRequestError(
      "Approved ceiling is below the documented upload byte tariff",
    );
  const preview = {
    dryRun: input.dryRun,
    jobId: null as string | null,
    sourceId: source.id,
    sha256: source.sha256,
    bytes: Number(source.byte_size),
    destination: input.destination,
    estimatedCredits,
    maxCredits: input.maxCredits,
    state: "preview",
  };
  const policy = (
    await app.db.execute<{ revision: number }>(
      sql`select revision from ofapi_collection_state where id=1`,
    )
  ).rows[0];
  if (policy?.revision !== input.expectedPolicyRevision)
    throw new ConflictError("Collection policy changed; preview again");
  if (input.dryRun) return preview;
  const job = await app.db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    await database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`media-upload:${input.pageId}:${input.requestId}`},0))`,
    );
    const target = {
      version: 1,
      sourceId: source.id,
      sourceSha256: source.sha256,
      sourceBytes: Number(source.byte_size),
      destination: input.destination,
      requestId: input.requestId,
      maxCredits: input.maxCredits,
      expectedPolicyRevision: input.expectedPolicyRevision,
    };
    const prior = (
      await database.execute<{ id: string }>(
        sql`select id from ofapi_capture_jobs where kind='media_upload' and page_id=${input.pageId} and target->>'requestId'=${input.requestId}`,
      )
    ).rows[0];
    if (prior) {
      const existing = (await getOfapiCaptureJob(database, prior.id))!;
      const { collectionJobId: _collection, ...frozen } = existing.target;
      if (hashOfapiCaptureValue(frozen) !== hashOfapiCaptureValue(target))
        throw new ConflictError(
          "Upload request identifier was already used for different approval",
        );
      return existing;
    }
    const collection = await createOfapiCollectionJob(
      database,
      {
        pageId: input.pageId,
        category: "vault_files",
        expectedRevision: input.expectedPolicyRevision,
        maxCredits: input.maxCredits,
        maxCalls: 100,
        maxBytes: Number(source.byte_size) + 16 * 1024 * 1024,
        from: null,
        to: null,
        selection: [source.id],
      },
      actorUserId,
    );
    await database.execute(
      sql`update ofapi_collection_jobs set target=target||'{"executor":"typed_upload"}'::jsonb where id=${collection.id}::uuid`,
    );
    const created = await createOrGetOfapiCaptureJob(database, {
      pageId: input.pageId,
      ofapiAccountId: source.account_id,
      kind: "media_upload",
      activeSlotKey: `page:${input.pageId}:upload:${input.requestId}`,
      target: { ...target, collectionJobId: collection.id },
      manifest: {
        version: "ofapi-upload-v1",
        actorUserId,
        sourceId: source.id,
        sha256: source.sha256,
        bytes: Number(source.byte_size),
        mimeType: source.mime_type,
        destination: input.destination,
        maxCredits: input.maxCredits,
        async: true,
      },
      budgetScope: "bulk",
      originPrincipalId: actorUserId,
      createdBy: "owner",
      maxCalls: 100,
      maxCredits: input.maxCredits,
    });
    await insertAuditEvent(database, {
      actorUserId,
      eventType: "admin.ofapi_media_upload",
      source: "dashboard",
      platformAccountId: input.pageId,
      metadata: {
        jobId: created.job.id,
        sourceId: source.id,
        destination: input.destination,
        maxCredits: input.maxCredits,
      },
    });
    return created.job;
  });
  return { ...preview, jobId: job.id, state: job.state };
}

/** Resume only an admission stop; immutable source, allowance and dispatch uncertainty remain fenced. */
export async function resumeOwnerOfapiMediaUpload(
  app: AppContext,
  input: {
    jobId: string;
    expectedRowVersion: number;
    expectedPolicyRevision: number;
    reason: string;
  },
  actorUserId: number,
) {
  return app.db.transaction(async (tx) => {
    const db = tx as unknown as Database;
    await db.execute(
      sql`select id from ofapi_capture_jobs where id=${input.jobId}::uuid for update`,
    );
    const job = await getOfapiCaptureJob(db, input.jobId);
    if (
      !job ||
      job.kind !== "media_upload" ||
      job.state !== "blocked" ||
      job.rowVersion !== input.expectedRowVersion ||
      ![
        "background_paused",
        "job_unavailable",
        "collection_off",
        "on_demand_only",
      ].includes(job.reasonCode ?? "")
    )
      throw new ConflictError(
        "Upload is not safely resumable from this snapshot",
      );
    await requireOfapiMediaSource(
      { db },
      String(job.target.sourceId),
      job.pageId,
    );
    const policy = (
      await db.execute<{ revision: number; background_paused: boolean }>(
        sql`select revision,background_paused from ofapi_collection_state where id=1 for update`,
      )
    ).rows[0];
    if (
      policy?.revision !== input.expectedPolicyRevision ||
      policy.background_paused
    )
      throw new ConflictError("Collection policy changed or remains paused");
    const uncertain = await db.execute(
      sql`select 1 from ofapi_request_attempts where owner_kind='capture_job' and owner_id=${job.id}::uuid and state in ('reserved','dispatching','indeterminate')`,
    );
    if (uncertain.rows.length)
      throw new ConflictError(
        "An upload request remains in flight or uncertain",
      );
    const resumed = await db.execute(
      sql`update ofapi_collection_jobs set state='queued',reason=null,policy_revision=${policy.revision},updated_at=now() where id=${String(job.target.collectionJobId)}::uuid and state in ('queued','running','paused') and used_calls<max_calls and used_bytes<max_bytes and used_credits<=max_credits returning id`,
    );
    if (!resumed.rows.length)
      throw new ConflictError("Upload allowance exhausted");
    await db.execute(
      sql`update ofapi_capture_jobs set state='ready',reason_code=null,reason_message=null,next_attempt_at=now(),row_version=row_version+1,updated_at=now() where id=${job.id}::uuid`,
    );
    await insertAuditEvent(db, {
      actorUserId,
      eventType: "admin.ofapi_media_resume",
      source: "dashboard",
      platformAccountId: job.pageId,
      metadata: {
        jobId: job.id,
        sourceId: job.target.sourceId,
        policyRevision: policy.revision,
        reason: input.reason,
      },
    });
    return {
      jobId: job.id,
      rowVersion: job.rowVersion + 1,
      state: "ready" as const,
    };
  });
}
