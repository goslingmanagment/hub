import { recordOfapiTypedFacts } from "./projections/ofapi-typed-exports.ts";
import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import type { z } from "zod";
import type { ofapiTypedExportCreateSchema, ofapiTypedExportArtifactSchema } from "@agency_hub_core/contracts";
import { OFAPI_TYPED_EXPORT_COLUMNS, isOfapiTypedExportProfile, ofapiTypedExportCategory } from "@agency_hub_core/shared";
import { approveBlockedOfapiExportPilotJob, createOfapiCollectionJob, createOrGetOfapiCaptureJob, findPageById, getOfapiCaptureJob, getOfapiCollectionJob, hashOfapiCaptureValue, insertObservation, markOfapiExportArtifactCaptured, updateOfapiCollectionJob, type Database, type OfapiCaptureJobRecord, type OfapiVisitorMetrics } from "@agency_hub_core/db";
import type { AppContext } from "../bootstrap.ts";
import { parseOfapiExportCursor, parseOfapiExportTarget } from "./ofapi-export-quotes.ts";
import { parseOfapiExportCsv } from "./ofapi-export-artifact.ts";
import { downloadOfapiExportArtifact } from "./egress/ofapi-export-artifact.ts";
import { BadRequestError, ConflictError, NotFoundError } from "./errors.ts";

function day(value: string) {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new BadRequestError("Invalid profile visitor date");
  return value;
}
function dateWindow(startDate: string, endDate: string) {
  const start = new Date(startDate), end = new Date(endDate);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start < new Date("2016-11-01T00:00:00Z") || start >= end || end >= new Date(new Date().toISOString().slice(0, 10))) throw new BadRequestError("Choose a closed historical window ending before today");
  const days = Math.floor((Date.parse(`${endDate.slice(0, 10)}T00:00:00Z`) - Date.parse(`${startDate.slice(0, 10)}T00:00:00Z`)) / 86400000) + 1;
  if (days > 366 || days < 1) throw new BadRequestError("Typed export windows are bounded to 366 days per page");
  return days;
}
export async function createOwnerOfapiTypedExport(app: AppContext, input: z.infer<typeof ofapiTypedExportCreateSchema>, actorUserId: number) {
  const days = dateWindow(input.startDate, input.endDate);
  if (input.profile === "profile_visitors" && (!input.startDate.includes("T00:00:00") || (!input.endDate.includes("T00:00:00") && !input.endDate.includes("T23:59:59")))) throw new BadRequestError("Visitor export bounds must cover complete UTC days");
  const page = await findPageById(app.db, input.pageId);
  if (!page?.page.ofapiAccountId || page.page.platform !== "onlyfans") throw new NotFoundError("Mapped OnlyFans page not found");
  const maxRows = input.profile === "profile_visitors" ? days : input.maxRows;
  if (maxRows > input.maxRows) throw new BadRequestError("maxRows is smaller than the selected account-day window");
  const category = ofapiTypedExportCategory(input.profile);
  const estimate = input.profile === "profile_visitors" ? Math.ceil(maxRows / 20) : input.profile === "smart_links" ? 0 : null;
  const preview = { dryRun: input.dryRun, jobId: null as string | null, profile: input.profile, category, maxRows, maximumCredits: input.maxCredits, estimatedCredits: estimate, estimateSource: estimate === null ? "unknown" as const : "documented_row_tariff" as const, state: "preview" };
  const policy = await app.db.execute<{ revision: number }>(sql`select revision from ofapi_collection_state where id=1`);
  if (policy.rows[0]?.revision !== input.expectedPolicyRevision) throw new ConflictError("Collection policy changed; reload and preview again");
  if (input.dryRun) return preview;
  const job = await app.db.transaction(async tx => {
    const database = tx as unknown as Database;
    const collection = await createOfapiCollectionJob(database, { pageId: input.pageId, category, expectedRevision: input.expectedPolicyRevision, maxCredits: input.maxCredits, maxCalls: 100, maxBytes: input.maxBytes, from: input.startDate, to: input.endDate, selection: [] }, actorUserId);
    await database.execute(sql`update ofapi_collection_jobs set target=target||${JSON.stringify({ executor: "typed_export", profile: input.profile })}::jsonb where id=${collection.id}::uuid`);
    const target = { profile: input.profile, type: input.profile, accountIds: [page.page.ofapiAccountId], startDate: input.startDate, endDate: input.endDate, fileType: "csv", maxMessages: maxRows, quoteTtlMinutes: 1440, chatIds: [], autoStart: false, collectionJobId: collection.id, maxArtifactBytes: input.maxBytes, fanType: input.fanType };
    const result = await createOrGetOfapiCaptureJob(database, { pageId: input.pageId, ofapiAccountId: page.page.ofapiAccountId!, kind: "account_export", activeSlotKey: `page:${input.pageId}:export`, target,
      manifest: { version: "ofapi-typed-export-v1", profile: input.profile, actorUserId, collectionJobId: collection.id, maxRows, maxBytes: input.maxBytes, maxCredits: input.maxCredits, autoStart: false }, budgetScope: "bulk", originPrincipalId: actorUserId, createdBy: "owner", maxCalls: 97, maxCredits: 5 });
    if (result.job.targetHash !== hashOfapiCaptureValue(target)) throw new ConflictError("A different export is already active on this page");
    return result.job;
  });
  return { ...preview, jobId: job.id, state: job.state };
}
export async function requireTypedExportJob(app: AppContext, id: string) {
  const job = await getOfapiCaptureJob(app.db, id);
  if (!job || job.kind !== "account_export" || !isOfapiTypedExportProfile(job.target.profile) || typeof job.target.collectionJobId !== "string") throw new NotFoundError("Typed export job not found");
  return job;
}
export async function approveOwnerOfapiTypedExport(app: AppContext, input: { jobId: string; expectedRowVersion: number; approvedMaxCredits: number; reason: string; dryRun: boolean }, actorUserId: number) {
  const job = await requireTypedExportJob(app, input.jobId);
  const collection = await getOfapiCollectionJob(app.db, String(job.target.collectionJobId));
  if (!collection || !["queued", "running"].includes(collection.state) || input.approvedMaxCredits > Number(collection.max_credits) - Number(collection.used_credits)) throw new ConflictError("Approval exceeds this task's remaining credit allowance or the task is paused");
  if (!isOfapiTypedExportProfile(job.target.profile)) throw new ConflictError("Typed export profile changed");
  const result = await approveBlockedOfapiExportPilotJob(app.db, { ...input, actorUserId, execute: !input.dryRun, typedProfile: job.target.profile });
  if (result.outcome !== "approved" && result.outcome !== "would_approve") throw new ConflictError(`Export cannot start: ${result.outcome}`);
  return { dryRun: input.dryRun, jobId: job.id, state: "ready" as const, rowVersion: result.next.rowVersion };
}
function numeric(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new BadRequestError("Visitor counts must be nonnegative safe integers or empty");
  return Number(value);
}
export function parseOfapiTypedExportArtifact(job: OfapiCaptureJobRecord, bytes: Buffer) {
  const profile = job.target.profile;
  if (!isOfapiTypedExportProfile(profile)) throw new BadRequestError("Unknown typed export profile");
  let csvText: string;
  try { csvText = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new BadRequestError("Export CSV is not valid UTF-8"); }
  const table = parseOfapiExportCsv(csvText); const header = table.shift() ?? [];
  if (header.join("\u0000") !== OFAPI_TYPED_EXPORT_COLUMNS[profile].join("\u0000")) throw new BadRequestError("Export CSV header differs from requested columns");
  const cursor = parseOfapiExportCursor(job);
  if (table.length > Number(job.target.maxMessages) || table.length !== cursor?.rowsProcessed) throw new BadRequestError("Artifact row count differs from approved cap or delivered rows");
  const keys = new Set<string>();
  return table.map(cells => {
    if (cells.length !== header.length) throw new BadRequestError("Malformed export CSV row");
    const data = Object.fromEntries(header.map((name, index) => [name, cells[index] === "" ? null : cells[index]!])) as Record<string, string | null>;
    if (data.account_id !== job.ofapiAccountId) throw new BadRequestError("Artifact contains a different account");
    const rowKey = profile === "profile_visitors" ? day(data.date ?? "") : data.onlyfans_id ?? data.link_url;
    if (!rowKey || keys.has(rowKey)) throw new BadRequestError("Artifact identity is missing or duplicated"); keys.add(rowKey);
    let metrics: OfapiVisitorMetrics | null = null;
    if (profile === "profile_visitors") {
      if (rowKey < String(job.target.startDate).slice(0, 10) || rowKey > String(job.target.endDate).slice(0, 10)) throw new BadRequestError("Visitor day is outside the frozen window");
      const totalVisitors = numeric(data.total_visitors ?? undefined), guestVisitors = numeric(data.guest_visitors ?? undefined), userVisitors = numeric(data.user_visitors ?? undefined), subscriberVisitors = numeric(data.subscriber_visitors ?? undefined);
      metrics = { date: rowKey, totalVisitors, guestVisitors, userVisitors, subscriberVisitors, avgViewDuration: data.avg_view_duration ?? null, chartDuration: null,
        availability: [totalVisitors, guestVisitors, userVisitors, subscriberVisitors].every(value => value !== null) ? "complete" : "partial" };
    }
    return { data, rowKey, metrics };
  });
}
export async function captureOwnerOfapiTypedArtifact(app: AppContext, input: z.infer<typeof ofapiTypedExportArtifactSchema> & { jobId: string }, actorUserId: number) {
  const job = await requireTypedExportJob(app, input.jobId); const target = parseOfapiExportTarget(job); const cursor = parseOfapiExportCursor(job);
  const prior = await app.db.execute<{ sha256: string; byte_size: string; row_count: number; state: string }>(sql`select * from ofapi_typed_export_artifacts where export_job_id=${job.id}::uuid`);
  if (prior.rows[0]?.state === "imported") {
    if (input.expectedSha256 && input.expectedSha256 !== prior.rows[0].sha256) throw new ConflictError("Artifact checksum differs from imported bytes");
    return { jobId: job.id, sha256: prior.rows[0].sha256, byteSize: Number(prior.rows[0].byte_size), rowCount: prior.rows[0].row_count, state: "imported" as const, duplicate: true };
  }
  if (!target || !cursor || job.rowVersion !== input.expectedRowVersion || job.state !== "blocked" || cursor.phase !== "artifact_pending" || cursor.vendorStatus !== "completed" || cursor.totalRows !== cursor.rowsProcessed || cursor.failedDownloads !== 0) throw new ConflictError("Export has no verified completed artifact or its version changed");
  let bytes: Buffer;
  if (input.csvBase64 !== undefined) {
    if (!input.expectedSha256) throw new BadRequestError("Manual CSV requires canonical base64 and its expected SHA256");
    bytes = Buffer.from(input.csvBase64, "base64");
    if (bytes.toString("base64") !== input.csvBase64) throw new BadRequestError("Manual CSV requires canonical base64 and its expected SHA256");
  } else {
    if (!cursor.downloadUrl || !app.config.ofapiExpectedTeamSlug) throw new ConflictError("A verified team and completed download URL are required");
    bytes = (await downloadOfapiExportArtifact({ url: cursor.downloadUrl, exportId: cursor.vendorExportId, teamSlug: app.config.ofapiExpectedTeamSlug, maxBytes: target.maxArtifactBytes ?? 4 * 1024 * 1024 })).bytes;
  }
  if (bytes.length < 1 || bytes.length > (target.maxArtifactBytes ?? 4 * 1024 * 1024)) throw new BadRequestError("Artifact exceeds the approved byte ceiling");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (input.expectedSha256 && input.expectedSha256 !== sha256) throw new BadRequestError("Artifact checksum mismatch");
  const now = new Date();
  // Immutable bytes are committed before parsing. Rejected imports retain their evidence.
  const observation = await insertObservation(app.db, { source: "ofapi_capture", producer: "ofapi-typed-export-artifact", platform: "onlyfans", accountId: job.pageId, nativeAccountRef: job.ofapiAccountId,
    kind: "ofapi.typed_export_artifact.v1", payload: { exportJobId: job.id, vendorExportId: cursor.vendorExportId, profile: target.profile, sha256, byteSize: bytes.length, encoding: "base64", bytes: bytes.toString("base64") },
    payloadHash: Buffer.from(sha256, "hex"), idempotencyKey: `typed-export:${job.id}:${sha256}`, actorPrincipalId: actorUserId, observedAt: now });
  await app.db.execute(sql`insert into ofapi_typed_export_artifacts(export_job_id,profile,sha256,byte_size,observation_id,observation_received_at,state)
    values(${job.id}::uuid,${target.profile},${sha256},${bytes.length},${observation.observationId},${observation.receivedAt},'captured') on conflict(export_job_id) do nothing`);
  const frozen = await app.db.execute<{ sha256: string }>(sql`select sha256 from ofapi_typed_export_artifacts where export_job_id=${job.id}::uuid`);
  if (frozen.rows[0]?.sha256 !== sha256) throw new ConflictError("Different artifact bytes were already captured for this export");
  let parsed: ReturnType<typeof parseOfapiTypedExportArtifact>;
  try { parsed = parseOfapiTypedExportArtifact(job, bytes); } catch (error) {
    await app.db.execute(sql`update ofapi_typed_export_artifacts set state='rejected',reason='artifact_contract_rejected' where export_job_id=${job.id}::uuid`);
    throw error;
  }
  if (!isOfapiTypedExportProfile(target.profile)) throw new ConflictError("Typed profile changed");
  const profile = target.profile;
  await app.db.transaction(async tx => {
    const database = tx as unknown as Database;
    await recordOfapiTypedFacts(database, job.pageId, parsed.map(row => ({ row: { jobId: job.id, profile, rowKey: row.rowKey, data: row.data }, metrics: row.metrics, source: "export", observationId: observation.observationId, observationReceivedAt: observation.receivedAt.toISOString() })), observation.observationId, observation.receivedAt);
    const parent = await markOfapiExportArtifactCaptured(database, { jobId: job.id, expectedRowVersion: input.expectedRowVersion, cursor: { ...cursor, phase: "artifact_captured", downloadUrl: null, artifactSha256: sha256 }, result: { classification: profile === "profile_visitors" ? "daily_metrics" : "item_presence", sha256, byteSize: bytes.length, rowCount: parsed.length, reason: input.reason }, observationId: observation.observationId, observationReceivedAt: observation.receivedAt, now });
    if (!parent) throw new ConflictError("Export changed during artifact commit");
    await database.execute(sql`update ofapi_typed_export_artifacts set state='imported',row_count=${parsed.length},reason=null,imported_at=${now} where export_job_id=${job.id}::uuid`);
    await updateOfapiCollectionJob(database, String(job.target.collectionJobId), { state: "completed", bytesAdded: bytes.length, checkpoint: { exportJobId: job.id, sha256 } });
  });
  return { jobId: job.id, sha256, byteSize: bytes.length, rowCount: parsed.length, state: "imported" as const, duplicate: false };
}
