import { sql } from "drizzle-orm";
import {
  findPageById,
  getOfapiCaptureJob,
  insertAuditEvent,
  isOfapiMediaTokenReserved,
} from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import type { OfapiCollectionHandler } from "./ofapi-collection-runner.ts";
import {
  buildOfapiMediaFact,
  mediaRecord,
  recordOfapiMediaFacts,
} from "./projections/ofapi-media.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";
import { ofapiCdnMaterialRef } from "./ofapi-media-uploads.ts";
export const materializeOfapiVaultCatalog: NonNullable<
  OfapiCollectionHandler["materialize"]
> = async (app, input) => {
  if (
    !["ofapi_read_vault_inventory", "ofapi_read_vault_item"].includes(
      input.step.operation,
    )
  )
    return;
  const root = mediaRecord(input.body),
    data = mediaRecord(root?.data);
  const items =
    input.step.operation === "ofapi_read_vault_item"
      ? [data]
      : Array.isArray(data?.list)
        ? data.list
        : null;
  if (!items || items.some((row) => !mediaRecord(row)))
    throw new Error("Vault metadata list shape changed");
  const accountId = input.step.pathname.split("/")[1]!;
  if (
    input.step.operation === "ofapi_read_vault_item" &&
    String(data?.id) !== input.step.pathname.split("/").at(-1)
  )
    throw new Error("Vault item identity changed");
  const facts = items.map((row) =>
    buildOfapiMediaFact(mediaRecord(row)!, {
      sourceKind: "ofapi.collection_read_response.v1",
      accountId,
      materialKind: "vault",
      observationId: input.observationId,
      observedAt: input.observationReceivedAt,
    }),
  );
  await recordOfapiMediaFacts(app.db, Number(input.job.page_id), facts);
};
export async function readOfapiMedia(
  app: AppContext,
  input: { pageId: number; offset: number; limit: number },
) {
  const page = await findPageById(app.db, input.pageId);
  if (!page?.page.ofapiAccountId)
    throw new NotFoundError("Mapped page not found");
  const account = page.page.ofapiAccountId;
  const sources = (
    await app.db.execute<{
      id: string;
      filename: string;
      mime_type: string;
      byte_size: string;
      sha256: string;
    }>(
      sql`select id,filename,mime_type,byte_size::text,sha256 from ofapi_media_sources where page_id=${input.pageId} and account_id=${account} order by created_at desc limit 100`,
    )
  ).rows.map((row) => ({
    id: row.id,
    pageId: input.pageId,
    filename: row.filename,
    mimeType: row.mime_type,
    bytes: Number(row.byte_size),
    sha256: row.sha256,
  }));
  const jobs = await app.db.execute<{ id: string }>(
    sql`select id from ofapi_capture_jobs where page_id=${input.pageId} and ofapi_account_id=${account} and kind='media_upload' order by created_at desc limit 100`,
  );
  const uploads = [];
  for (const row of jobs.rows) {
    const job = (await getOfapiCaptureJob(app.db, row.id))!;
    uploads.push({
      id: job.id,
      sourceId: String(job.target.sourceId),
      destination: job.target.destination as "vault" | "cdn",
      state: job.state,
      rowVersion: job.rowVersion,
      reason: job.reasonCode,
      uploadId: null,
      mediaRef:
        job.target.destination === "vault" &&
        typeof job.cursor?.mediaRef === "string"
          ? job.cursor.mediaRef
          : null,
      uploadStatus:
        typeof job.cursor?.status === "string" ? job.cursor.status : null,
      isReady:
        typeof job.cursor?.isReady === "boolean" ? job.cursor.isReady : null,
      spentCredits: job.spentCredits,
      actualCredits:
        typeof job.cursor?.actualCredits === "number"
          ? job.cursor.actualCredits
          : null,
      collectionJobId: String(job.target.collectionJobId),
      createdAt: job.createdAt.toISOString(),
    });
  }
  const rows = await app.db.execute<Record<string, unknown>>(
    sql`select * from ofapi_media_catalog where page_id=${input.pageId} and account_id=${account} order by observation_received_at desc,media_ref limit ${input.limit} offset ${input.offset}`,
  );
  const media = rows.rows.map((row) => ({
    mediaRef: String(row.media_ref),
    materialKind: row.material_kind as "vault" | "cdn",
    uploadJobId: row.upload_job_id as string | null,
    sourceId: row.source_id as string | null,
    isReady: row.is_ready as boolean | null,
    uploadStatus: row.upload_status as string | null,
    providerType: row.provider_type as string | null,
    hasError: row.has_error as boolean | null,
    canView: row.can_view as boolean | null,
    filename: row.filename as string | null,
    bytes: row.byte_size === null ? null : Number(row.byte_size),
    duration: row.duration === null ? null : Number(row.duration),
    width: row.width === null ? null : Number(row.width),
    height: row.height === null ? null : Number(row.height),
    releaseForms: row.release_forms as Array<{
      id: string;
      name: string | null;
      status: string | null;
    }>,
    observedAt: new Date(row.observation_received_at as Date).toISOString(),
    observationId: Number(row.observation_id),
  }));
  const count = (
    await app.db.execute<{ n: string }>(
      sql`select count(*)::text n from ofapi_media_catalog where page_id=${input.pageId} and account_id=${account}`,
    )
  ).rows[0];
  const latest = (
    await app.db.execute<{
      id: string;
      state: string;
      checkpoint: Record<string, unknown>;
      updated_at: Date;
    }>(
      sql`select id,state,checkpoint,updated_at from ofapi_collection_jobs where page_id=${input.pageId} and category='vault_catalog' order by created_at desc limit 1`,
    )
  ).rows[0];
  const plan = Array.isArray(latest?.checkpoint.plan)
    ? latest.checkpoint.plan
    : [];
  const full =
    latest?.state === "completed" &&
    plan.some((value) => {
      const step = mediaRecord(value),
        query = mediaRecord(step?.query);
      return (
        step?.operation === "ofapi_read_vault_inventory" &&
        String(step.pathname).startsWith(`/${account}/`) &&
        query &&
        Object.keys(query).every((key) =>
          ["limit", "offset", "sort", "field"].includes(key),
        ) &&
        Number(query.offset ?? 0) === 0
      );
    });
  return {
    pageId: input.pageId,
    sources,
    uploads,
    media,
    totalMedia: Number(count?.n ?? 0),
    inventory: {
      state: full
        ? ("complete" as const)
        : latest || media.length
          ? ("partial" as const)
          : ("never" as const),
      completedAt: full ? new Date(latest!.updated_at).toISOString() : null,
      jobId: latest?.id ?? null,
      note: "Completeness describes one captured vault traversal at its observation time. Filtered or interrupted traversals stay partial; absent rendition URLs never prove missing media.",
    },
  };
}
export async function handoffOfapiMedia(
  app: AppContext,
  input: {
    pageId: number;
    jobId?: string | undefined;
    mediaRef?: string | undefined;
    expectedRowVersion?: number | undefined;
    expectedObservationId?: number | undefined;
    reason: string;
  },
  actorUserId: number,
) {
  const page = await findPageById(app.db, input.pageId);
  if (!page?.page.ofapiAccountId)
    throw new NotFoundError("Mapped page not found");
  const account = page.page.ofapiAccountId;
  let materialId: string, kind: "vault" | "cdn", isReady: boolean | null;
  if (input.jobId) {
    const job = await getOfapiCaptureJob(app.db, input.jobId);
    if (
      !job ||
      job.kind !== "media_upload" ||
      job.pageId !== input.pageId ||
      job.ofapiAccountId !== account ||
      job.rowVersion !== input.expectedRowVersion ||
      job.state !== "complete" ||
      job.cursor?.status !== "completed" ||
      typeof job.cursor.mediaRef !== "string"
    )
      throw new ConflictError(
        "Upload handoff snapshot changed or is incomplete",
      );
    kind = job.target.destination as "vault" | "cdn";
    materialId = job.cursor.mediaRef;
    isReady =
      typeof job.cursor.isReady === "boolean" ? job.cursor.isReady : null;
    if (kind === "cdn" && (job.cursor.hasError === true || isReady === false))
      throw new ConflictError("Media is not ready for handoff");
    if (kind === "vault") {
      const saved = (
        await app.db.execute<{
          is_ready: boolean | null;
          has_error: boolean | null;
          can_view: boolean | null;
        }>(
          sql`select is_ready,has_error,can_view from ofapi_media_catalog where page_id=${input.pageId} and account_id=${account} and material_kind='vault' and media_ref=${materialId}`,
        )
      ).rows[0];
      if (
        !saved ||
        saved.is_ready !== true ||
        saved.has_error === true ||
        saved.can_view === false
      )
        throw new ConflictError(
          "Refresh vault metadata until transcoding is ready",
        );
      isReady = saved.is_ready;
    }
  } else {
    if (!input.mediaRef || !/^\d+$/.test(input.mediaRef))
      throw new BadRequestError("Choose one vault media item");
    kind = "vault";
    materialId = input.mediaRef;
    const saved = (
      await app.db.execute<{
        is_ready: boolean | null;
        has_error: boolean | null;
        can_view: boolean | null;
        observation_id: string;
      }>(
        sql`select is_ready,has_error,can_view,observation_id from ofapi_media_catalog where page_id=${input.pageId} and account_id=${account} and material_kind='vault' and media_ref=${materialId}`,
      )
    ).rows[0];
    if (
      !saved ||
      Number(saved.observation_id) !== input.expectedObservationId ||
      saved.is_ready !== true ||
      saved.has_error === true ||
      saved.can_view === false
    )
      throw new ConflictError("Vault item changed or is not ready");
    isReady = saved.is_ready;
  }
  if (kind === "cdn") {
    if (await isOfapiMediaTokenReserved(app.db, account, materialId))
      throw new ConflictError(
        "This one-use material is already reserved or consumed; an unknown send remains quarantined",
      );
  }
  await insertAuditEvent(app.db, {
    actorUserId,
    eventType: "admin.ofapi_media_handoff",
    source: "dashboard",
    platformAccountId: input.pageId,
    metadata: {
      jobId: input.jobId ?? null,
      materialKind: kind,
      materialRef:
        kind === "cdn" ? ofapiCdnMaterialRef(materialId) : materialId,
      reason: input.reason,
    },
  });
  return {
    materialId,
    materialKind: kind,
    isReady,
    note:
      kind === "cdn"
        ? "Use once in a message. Upload completion confirms send material; rendition readiness may remain unknown. An unknown send keeps this token quarantined."
        : "Reusable vault media. Reusing this ID does not upload the source file again.",
  };
}
