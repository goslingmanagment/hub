import { sql } from "drizzle-orm";
import { createOfapiCollectionJob, createOrGetOfapiCaptureJob, findPageById, getOfapiCaptureJob, hashOfapiCaptureValue as hashCursor, insertAuditEvent, settleOfapiCaptureParse, updateOfapiCollectionJob, type Database } from "@agency_hub_core/db";
import { isOfapiTypedExportProfile, ofapiTypedExportCategory } from "@agency_hub_core/shared";
import type { AppContext } from "../bootstrap.ts";
import { BadRequestError, ConflictError, ServiceUnavailableError } from "./errors.ts";
import { parseOfapiExportCursor, parseOfapiExportTarget, type parseCapturedOfapiExportQuote, type ExportQuoteTarget } from "./ofapi-export-quotes.ts";
import { requireTypedExportJob } from "./ofapi-typed-exports.ts";

export async function prepareOwnerOfapiExportControl(app: AppContext, input: { jobId: string; action: "cancel" | "retry"; expectedRowVersion: number; expectedPolicyRevision: number; approvedMaxCredits: number; reason: string; dryRun: boolean }, actorUserId: number) {
  return app.db.transaction(async tx => {
    const database = tx as unknown as Database;
    await database.execute(sql`select id from ofapi_capture_jobs where id=${input.jobId}::uuid for update`);
    const source = await requireTypedExportJob({ ...app, db: database }, input.jobId);
    const target = parseOfapiExportTarget(source), cursor = parseOfapiExportCursor(source);
    if (!target || !cursor || !isOfapiTypedExportProfile(target.profile) || target.controlAction === "cancel" || source.rowVersion !== input.expectedRowVersion) throw new ConflictError("Export action snapshot changed");
    const page = await findPageById(database, source.pageId);
    if (page?.page.ofapiAccountId !== source.ofapiAccountId) throw new ConflictError("The export account no longer matches this page");
    const policy = await database.execute<{ revision: number }>(sql`select revision from ofapi_collection_state where id=1`);
    if (policy.rows[0]?.revision !== input.expectedPolicyRevision) throw new ConflictError("Collection policy changed");
    if (input.action === "cancel") {
      if (!["ready", "retry_wait", "blocked"].includes(source.state) || cursor.phase !== "in_progress" || !["pending", "in_progress"].includes(cursor.vendorStatus) || source.reasonCode === "vendor_cancel_pending") throw new ConflictError("Only a captured running export with no request in flight can be cancelled");
    } else {
      if (source.state !== "blocked" || cursor.vendorStatus !== "failed" || source.reasonCode !== "export_failed") throw new ConflictError("Only a captured failed export can be retried");
      const maximum = cursor.creditCost === null ? Math.ceil(target.maxMessages / 20) : Math.max(1, cursor.creditCost);
      if (target.profile !== "profile_visitors" && (cursor.creditCost === null || cursor.totalRows === null)) throw new ConflictError("This retry needs bounded captured row and price evidence");
      if ((cursor.totalRows !== null && cursor.totalRows > target.maxMessages) || input.approvedMaxCredits < maximum) throw new ConflictError("Retry exceeds the reviewed row or credit ceiling");
    }
    const preview = { dryRun: input.dryRun, action: input.action, sourceJobId: source.id, vendorExportId: cursor.vendorExportId, profile: target.profile, maximumCredits: input.action === "cancel" ? 0 : input.approvedMaxCredits, jobId: null as string | null, rowVersion: source.rowVersion };
    if (input.dryRun) return preview;
    const collection = await createOfapiCollectionJob(database, { expectedRevision: input.expectedPolicyRevision, pageId: source.pageId, category: ofapiTypedExportCategory(target.profile), maxCredits: input.action === "cancel" ? 1 : input.approvedMaxCredits, maxCalls: input.action === "cancel" ? 1 : 100, maxBytes: target.maxArtifactBytes ?? 4 * 1024 * 1024, from: target.startDate, to: target.endDate, selection: [] }, actorUserId);
    await database.execute(sql`update ofapi_collection_jobs set target=target||${JSON.stringify({ executor: "typed_export", action: input.action })}::jsonb where id=${collection.id}::uuid`);
    // Lock/park the source before dispatching a separate durable control intent.
    await database.execute(sql`update ofapi_capture_jobs set state=${input.action === "retry" ? "cancelled" : "blocked"},completed_at=${input.action === "retry" ? new Date() : null},reason_code=${input.action === "retry" ? "vendor_retry_requested" : "vendor_cancel_pending"},row_version=row_version+1,updated_at=now() where id=${source.id}::uuid`);
    if (input.action === "retry") await updateOfapiCollectionJob(database, String(source.target.collectionJobId), { state: "failed", reason: "vendor_retry_requested" });
    const child = await createOrGetOfapiCaptureJob(database, { pageId: source.pageId, ofapiAccountId: source.ofapiAccountId, kind: "account_export", activeSlotKey: input.action === "retry" ? source.activeSlotKey : `page:${source.pageId}:export-cancel:${source.id}`, target: { ...source.target, collectionJobId: collection.id, controlAction: input.action, sourceJobId: source.id, controlVendorExportId: cursor.vendorExportId }, manifest: { version: "ofapi-export-control-v1", action: input.action, sourceJobId: source.id, sourceRowVersion: source.rowVersion, actorUserId, maximumCredits: preview.maximumCredits, reason: input.reason }, budgetScope: "bulk", originPrincipalId: actorUserId, createdBy: "owner", maxCalls: input.action === "cancel" ? 1 : 100, maxCredits: Math.max(1, preview.maximumCredits) });
    const nextCursor = { ...cursor, phase: "owner_approved", startAttemptId: null, approvedMaxCredits: Math.max(1, preview.maximumCredits), approvedAt: new Date().toISOString(), approvedByUserId: actorUserId, approvalReason: input.reason, downloadUrl: null };
    await database.execute(sql`update ofapi_capture_jobs set cursor=${JSON.stringify(nextCursor)}::jsonb,cursor_hash=${hashCursor(nextCursor)} where id=${child.job.id}::uuid`);
    await insertAuditEvent(database, { actorUserId, eventType: `admin.ofapi_export_${input.action}`, source: "dashboard", platformAccountId: source.pageId, metadata: { jobId: child.job.id, sourceJobId: source.id, vendorExportId: cursor.vendorExportId, maximumCredits: preview.maximumCredits, reason: input.reason } });
    return { ...preview, jobId: child.job.id, rowVersion: source.rowVersion + 1 };
  });
}
export async function settleCapturedOfapiExportCancellation(app: AppContext, input: Parameters<typeof parseCapturedOfapiExportQuote>[1], target: ExportQuoteTarget): Promise<"success" | "blocked"> {
  const root = object(input.parsedJson.body); const data = object(root?.data);
  const accepted = data?.id === target.controlVendorExportId && data?.status === "cancelled";
  return app.db.transaction(async tx => {
    const database = tx as unknown as Database;
    const settled = await settleOfapiCaptureParse(database, { jobId: input.job.id, attemptId: input.attemptId, leaseToken: input.job.leaseToken!, observationId: input.observationId, observationReceivedAt: input.observationReceivedAt, parserOutcome: accepted ? "accepted" : "contract_rejected", rawCount: 1, acceptedCount: accepted ? 1 : 0, boundaryDuplicateCount: 0, explicitlyIrrelevantCount: 0, rejectedCount: accepted ? 0 : 1, disposition: { kind: "blocked", reasonCode: accepted ? "vendor_cancelled" : "export_cancel_contract_rejected" } });
    if (!settled || !accepted) return "blocked";
    // Cancellation acknowledges this export only; it does not erase earlier charges.
    for (const id of new Set([input.job.id, target.sourceJobId!])) {
      const row = await getOfapiCaptureJob(database, id);
      if (!row) continue;
      const cursor = { ...row.cursor, vendorStatus: "cancelled" };
      await database.execute(sql`update ofapi_capture_jobs set state='cancelled',completed_at=now(),terminal_observation_id=${input.observationId},terminal_observation_received_at=${input.observationReceivedAt},reason_code='vendor_cancelled',cursor=${JSON.stringify(cursor)}::jsonb,cursor_hash=${hashCursor(cursor)},row_version=row_version+1,updated_at=now() where id=${id}::uuid`);
    }
    await updateOfapiCollectionJob(database, String(input.job.target.collectionJobId), { state: "completed", checkpoint: { cancelledExportId: target.controlVendorExportId } });
    const source = await getOfapiCaptureJob(database, target.sourceJobId!);
    if (typeof source?.target.collectionJobId === "string") await updateOfapiCollectionJob(database, source.target.collectionJobId, { state: "failed", reason: "vendor_cancelled" });
    return "success";
  });
}
/** A rejected/unknown cancellation can reconcile the original ID with GET; never repeat DELETE. */
export async function resumeOfapiExportCancellationStatus(app: AppContext) {
  await app.db.transaction(async tx => {
    const database = tx as unknown as Database;
    const rows = await database.execute<{ id: string; source_id: string; target: Record<string, unknown> }>(sql`
      select c.id,s.id as source_id,c.target from ofapi_capture_jobs c join ofapi_capture_jobs s on c.target->>'sourceJobId'=s.id::text
      where c.target->>'controlAction'='cancel' and c.state in ('blocked','indeterminate')
        and s.state='blocked' and s.reason_code='vendor_cancel_pending'
        and c.target->>'controlVendorExportId'=s.cursor->>'vendorExportId'
      order by c.updated_at limit 5 for update of s skip locked`);
    for (const row of rows.rows) {
      await database.execute(sql`update ofapi_capture_jobs set state='retry_wait',reason_code='export_cancel_status_reconcile',next_attempt_at=now(),row_version=row_version+1,updated_at=now() where id=${row.source_id}::uuid`);
      if (typeof row.target.collectionJobId === "string") await updateOfapiCollectionJob(database, row.target.collectionJobId, { state: "failed", reason: "export_cancel_status_reconcile" });
    }
  });
}
function object(value: unknown): Record<string, unknown> | null { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null; }
export function parseOfapiExportInventory(body: unknown) {
  const data = object(object(body)?.data), meta = object(data?.meta);
  if (!Array.isArray(data?.data) || data.data.length > 100 || !meta || !Number.isSafeInteger(meta.current_page) || !Number.isSafeInteger(meta.last_page)) throw new BadRequestError("Vendor export inventory shape changed");
  const rows = data.data.map(value => {
    const row = object(value);
    if (!row || typeof row.id !== "string" || !/^data_export_[A-Za-z0-9_-]+$/.test(row.id) || typeof row.type !== "string" || typeof row.status !== "string") throw new BadRequestError("Vendor export inventory identity changed");
    return { id: row.id, type: row.type, status: row.status, totalRows: typeof row.total_rows === "number" ? row.total_rows : null, deliveredRows: typeof row.rows_processed === "number" ? row.rows_processed : null, creditCost: typeof row.credit_cost === "number" ? row.credit_cost : null, accounts: Array.isArray(row.accounts) ? row.accounts.flatMap(value => { const account = object(value); return typeof account?.id === "string" ? [account.id] : []; }) : [] };
  });
  return { rows, currentPage: Number(meta.current_page), lastPage: Number(meta.last_page) };
}
export async function readOfapiExportInventory(app: AppContext) {
  const result = await app.db.execute<{ id: string; received_at: Date; payload: { body: string; status: number } }>(sql`select id,received_at,payload from observations where source='operator' and kind='ofapi_export_inventory' order by received_at desc,id desc limit 1`);
  const row = result.rows[0];
  if (!row) return { rows: [], currentPage: 1, lastPage: 1, observedAt: null as string | null, observationId: null as number | null };
  if (row.payload.status !== 200) throw new ConflictError("Last vendor inventory refresh was not successful; its response is retained");
  return { ...parseOfapiExportInventory(JSON.parse(row.payload.body)), observedAt: new Date(row.received_at).toISOString(), observationId: Number(row.id) };
}
export async function refreshOfapiExportInventory(app: AppContext, input: { page: number; perPage: number; type: string }) {
  if (!app.ofapi?.listDataExports) throw new ServiceUnavailableError("OFAPI export inventory transport is unavailable");
  const response = await app.ofapi.listDataExports(input);
  if (!response.capture) throw new ConflictError("Export inventory response was not captured");
  return { ...parseOfapiExportInventory(response.body), observedAt: response.capture.receivedAt.toISOString(), observationId: response.capture.observationId };
}
