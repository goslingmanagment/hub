import { sql } from "drizzle-orm";
import {
  appendProjectionOnlyDomainEventsInTransaction,
  isDmArchiveScopeFenced,
  tryAcquireDmArchiveWriterFenceLock,
  getProjectionWatermark,
  hashOfapiCaptureValue,
  listEventAccounts,
  listEventsSince,
  setProjectionWatermark,
  type Database,
} from "@agency_hub_core/db";
import type { AppContext } from "../../bootstrap.ts";
import { onlyFansRawMediaDrafts } from "../canonicalize/raw-media.ts";
export const OFAPI_MEDIA_EVENT = "ofapi.media_observed",
  OFAPI_MEDIA_PROJECTION = "ofapi_media";
export function mediaRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
function string(value: unknown) {
  return typeof value === "string" ? value : null;
}
function flag(value: unknown) {
  return typeof value === "boolean" ? value : null;
}
function number(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;
}
function integer(value: unknown) {
  return typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 2147483647
    ? value
    : null;
}
export interface OfapiMediaFact {
  accountId: string;
  sourceKind: string;
  mediaRef: string;
  materialKind: "vault" | "cdn";
  uploadJobId: string | null;
  sourceId: string | null;
  uploadStatus: string | null;
  isReady: boolean | null;
  providerType: string | null;
  hasError: boolean | null;
  canView: boolean | null;
  filename: string | null;
  mimeType: string | null;
  byteSize: number | null;
  duration: number | null;
  width: number | null;
  height: number | null;
  releaseFormsObserved: boolean;
  releaseForms: Array<{
    id: string;
    name: string | null;
    status: string | null;
  }>;
  observationId: number;
  observedAt: string;
}
export function buildOfapiMediaFact(
  media: Record<string, unknown>,
  input: {
    sourceKind: string;
    accountId: string;
    materialKind: "vault" | "cdn";
    mediaRef?: string;
    uploadJobId?: string;
    sourceId?: string;
    uploadStatus?: string;
    observationId: number;
    observedAt: Date;
  },
): OfapiMediaFact {
  const mediaRef =
    input.mediaRef ??
    (typeof media.id === "number" && Number.isSafeInteger(media.id)
      ? String(media.id)
      : string(media.id));
  if (
    !mediaRef ||
    (input.materialKind === "vault"
      ? !/^\d+$/.test(mediaRef)
      : !/^cdn_sha256:[0-9a-f]{64}$/.test(mediaRef))
  )
    throw new Error("Media identity differs from the requested material kind");
  const full = mediaRecord(mediaRecord(media.files)?.full);
  const releaseForms = Array.isArray(media.releaseForms)
    ? media.releaseForms.flatMap((value) => {
        const row = mediaRecord(value),
          id =
            typeof row?.id === "string"
              ? row.id
              : typeof row?.id === "number" && Number.isSafeInteger(row.id)
                ? String(row.id)
                : null;
        return id
          ? [{ id, name: string(row?.name), status: string(row?.status) }]
          : [];
      })
    : [];
  return {
    sourceKind: input.sourceKind,
    accountId: input.accountId,
    mediaRef,
    materialKind: input.materialKind,
    uploadJobId: input.uploadJobId ?? null,
    sourceId: input.sourceId ?? null,
    uploadStatus: input.uploadStatus ?? null,
    isReady: flag(media.isReady),
    providerType: string(media.type),
    hasError: flag(media.hasError),
    canView: flag(media.canView),
    filename: string(media.filename) ?? string(media.file_name),
    mimeType: string(media.mimetype),
    byteSize: number(full?.size),
    duration: number(media.duration),
    width: integer(full?.width) ?? integer(media.width),
    height: integer(full?.height) ?? integer(media.height),
    releaseFormsObserved: Array.isArray(media.releaseForms),
    releaseForms,
    observationId: input.observationId,
    observedAt: input.observedAt.toISOString(),
  };
}
async function allowed(db: Database, pageId: number, fact: OfapiMediaFact) {
  if (!(await tryAcquireDmArchiveWriterFenceLock(db, pageId)))
    throw new Error("Media projection deferred during page erasure");
  return !(await isDmArchiveScopeFenced(db, {
    pageId,
    refs: [],
    materialAt: new Date(fact.observedAt),
  }));
}
async function apply(db: Database, pageId: number, fact: OfapiMediaFact) {
  if (!(await allowed(db, pageId, fact))) return;
  await db.execute(sql`insert into ofapi_media_catalog(account_id,page_id,media_ref,material_kind,upload_job_id,source_id,upload_status,is_ready,provider_type,has_error,can_view,filename,mime_type,byte_size,duration,width,height,release_forms,metadata,observation_id,observation_received_at)
 values(${fact.accountId},${pageId},${fact.mediaRef},${fact.materialKind},${fact.uploadJobId}::uuid,${fact.sourceId}::uuid,${fact.uploadStatus},${fact.isReady},${fact.providerType},${fact.hasError},${fact.canView},${fact.filename},${fact.mimeType},${fact.byteSize},${fact.duration},${fact.width},${fact.height},${JSON.stringify(fact.releaseForms)}::jsonb,${JSON.stringify(fact)}::jsonb,${fact.observationId},${new Date(fact.observedAt)})
 on conflict(page_id,account_id,material_kind,media_ref) do update set upload_job_id=coalesce(excluded.upload_job_id,ofapi_media_catalog.upload_job_id),source_id=coalesce(excluded.source_id,ofapi_media_catalog.source_id),upload_status=coalesce(excluded.upload_status,ofapi_media_catalog.upload_status),is_ready=coalesce(excluded.is_ready,ofapi_media_catalog.is_ready),provider_type=coalesce(excluded.provider_type,ofapi_media_catalog.provider_type),has_error=coalesce(excluded.has_error,ofapi_media_catalog.has_error),can_view=coalesce(excluded.can_view,ofapi_media_catalog.can_view),filename=coalesce(excluded.filename,ofapi_media_catalog.filename),mime_type=coalesce(excluded.mime_type,ofapi_media_catalog.mime_type),byte_size=coalesce(excluded.byte_size,ofapi_media_catalog.byte_size),duration=coalesce(excluded.duration,ofapi_media_catalog.duration),width=coalesce(excluded.width,ofapi_media_catalog.width),height=coalesce(excluded.height,ofapi_media_catalog.height),release_forms=case when excluded.metadata->>'releaseFormsObserved'='true' then excluded.release_forms else ofapi_media_catalog.release_forms end,metadata=excluded.metadata,observation_id=excluded.observation_id,observation_received_at=excluded.observation_received_at
 where (excluded.observation_received_at,excluded.observation_id)>(ofapi_media_catalog.observation_received_at,ofapi_media_catalog.observation_id)`);
}
export async function recordOfapiMediaFacts(
  db: Database,
  pageId: number,
  facts: OfapiMediaFact[],
) {
  if (!facts.length) return;
  await db.transaction(async (tx) => {
    const database = tx as unknown as Database;
    for (const fact of facts) {
      if (!(await allowed(database, pageId, fact))) continue;
      // The canonical writer requires the captured envelope, including its original provenance.
      // Keep this check, event dedup claim and projection mutation under the same erasure lock.
      const capture = (
        await database.execute<{
          source: string;
          kind: string;
          account_id: number | null;
        }>(
          sql`select source,kind,account_id from observations where id=${fact.observationId} and received_at=${new Date(fact.observedAt)}`,
        )
      ).rows[0];
      if (
        !capture ||
        capture.kind !== fact.sourceKind ||
        !["webhook", "ofapi_capture"].includes(capture.source) ||
        (capture.account_id !== null && Number(capture.account_id) !== pageId)
      )
        throw new Error(
          "Media canonicalization requires its captured page-scoped source",
        );
      const observedAt = new Date(fact.observedAt),
        key = `ofapi-media:${fact.observationId}:${hashOfapiCaptureValue(fact)}`;
      const native =
        fact.materialKind === "vault"
          ? onlyFansRawMediaDrafts(
              {
                id: fact.observationId,
                source: capture.source as "webhook" | "ofapi_capture",
                producer: "ofapi-media",
                platform: "onlyfans",
                accountId: pageId,
                kind: fact.sourceKind,
                payload: {},
                observedAt,
                receivedAt: observedAt,
              },
              [
                {
                  id: fact.mediaRef,
                  type: fact.providerType,
                  filename: fact.filename,
                  mimetype: fact.mimeType,
                  duration: fact.duration,
                  width: fact.width,
                  height: fact.height,
                },
              ],
              "vault",
            )
          : [];
      await appendProjectionOnlyDomainEventsInTransaction(
        database,
        pageId,
        [
          {
            type: OFAPI_MEDIA_EVENT,
            occurredAt: observedAt,
            observationId: fact.observationId,
            data: fact,
            schemaVersion: 1,
            dedupKey: key,
          },
          ...native.map((draft) => ({
            ...draft,
            observationId: fact.observationId,
          })),
        ],
        {
          occurredAt: observedAt,
          observationId: fact.observationId,
          dedupKey: `${key}:checkpoint`,
        },
      );
      await apply(database, pageId, fact);
    }
  });
}
export async function runOfapiMediaProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
) {
  let applied = 0;
  const accounts =
    input?.accountId != null
      ? [input.accountId]
      : await listEventAccounts(app.db);
  for (const accountId of accounts) {
    let watermark = await getProjectionWatermark(
      app.db,
      OFAPI_MEDIA_PROJECTION,
      accountId,
    );
    for (;;) {
      const events = await listEventsSince(app.db, {
        accountId,
        afterSeq: watermark,
        limit: 500,
      });
      if (!events.length) break;
      await app.db.transaction(async (tx) => {
        const db = tx as unknown as Database;
        for (const event of events)
          if (event.type === OFAPI_MEDIA_EVENT) {
            await apply(db, accountId, event.data as unknown as OfapiMediaFact);
            applied++;
          }
        watermark = events[events.length - 1]!.accountSeq;
        await setProjectionWatermark(
          db,
          OFAPI_MEDIA_PROJECTION,
          accountId,
          watermark,
        );
      });
      if (events.length < 500) break;
    }
  }
  return { applied };
}
export async function rebuildOfapiMediaProjection(
  app: Pick<AppContext, "db" | "logger">,
  input?: { accountId?: number | null },
) {
  await app.db.transaction(async (tx) => {
    await tx.execute(
      sql`delete from ofapi_media_catalog ${input?.accountId == null ? sql`` : sql`where page_id=${input.accountId}`}`,
    );
    await tx.execute(
      sql`delete from projection_seq_watermarks where projection=${OFAPI_MEDIA_PROJECTION} ${input?.accountId == null ? sql`` : sql`and account_id=${input.accountId}`}`,
    );
  });
  return runOfapiMediaProjection(app, input);
}
