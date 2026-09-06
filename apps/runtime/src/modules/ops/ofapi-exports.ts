import { prepareOwnerOfapiExportControl, readOfapiExportInventory, refreshOfapiExportInventory } from "../../services/ofapi-export-controls.ts";
import { ofapiExportRouteSchemas } from "@agency_hub_core/contracts";
import { getOfapiCaptureJob, listOfapiProfileVisitorsDaily, listOfapiTypedExportRows } from "@agency_hub_core/db";
import { isOfapiTypedExportProfile, OFAPI_TYPED_EXPORT_PROFILES } from "@agency_hub_core/shared";
import { sql } from "drizzle-orm";
import { canAccessPage, requireDashboardUser, requireOwner } from "../../services/auth.ts";
import { BadRequestError, ForbiddenError } from "../../services/errors.ts";
import { approveOwnerOfapiTypedExport, captureOwnerOfapiTypedArtifact, createOwnerOfapiTypedExport, requireTypedExportJob } from "../../services/ofapi-typed-exports.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

export function registerOfapiExportRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext: app, auth: { requirePrincipal } } = ctx;
  server.get("/api/v1/admin/ofapi/export-inventory", { schema: ofapiExportRouteSchemas.ofapiExportInventoryGet }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal); return readOfapiExportInventory(app);
  });
  server.post("/api/v1/admin/ofapi/export-inventory/refresh", { schema: ofapiExportRouteSchemas.ofapiExportInventoryRefresh }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal); return refreshOfapiExportInventory(app, request.body);
  });
  server.post("/api/v1/admin/ofapi/exports/:jobId/control", { schema: ofapiExportRouteSchemas.ofapiTypedExportControl }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal); return prepareOwnerOfapiExportControl(app, { ...request.body, jobId: request.params.jobId }, principal.user.id);
  });
  server.post("/api/v1/admin/ofapi/exports", { schema: ofapiExportRouteSchemas.ofapiTypedExportCreate }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return createOwnerOfapiTypedExport(app, request.body, principal.user.id);
  });
  server.post("/api/v1/admin/ofapi/exports/:jobId/approve", { schema: ofapiExportRouteSchemas.ofapiTypedExportApprove }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return approveOwnerOfapiTypedExport(app, { ...request.body, jobId: request.params.jobId }, principal.user.id);
  });
  server.post("/api/v1/admin/ofapi/exports/:jobId/artifact", { bodyLimit: 24 * 1024 * 1024, schema: ofapiExportRouteSchemas.ofapiTypedExportArtifact }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return captureOwnerOfapiTypedArtifact(app, { ...request.body, jobId: request.params.jobId }, principal.user.id);
  });
  server.get("/api/v1/admin/ofapi/exports", { schema: ofapiExportRouteSchemas.ofapiTypedExportList }, async request => {
    const principal = await requirePrincipal(request); requireDashboardUser(principal);
    if (!canAccessPage(principal, request.query.pageId)) throw new ForbiddenError();
    const ids = await app.db.execute<{ id: string }>(sql`select j.id from ofapi_capture_jobs j where j.page_id=${request.query.pageId}
      and j.target->>'profile' in (${sql.join(OFAPI_TYPED_EXPORT_PROFILES.map(profile => sql`${profile}`), sql`,`)}) order by j.created_at desc limit 100`);
    const jobs = [];
    for (const id of ids.rows) {
      const job = await getOfapiCaptureJob(app.db, id.id); if (!job || !isOfapiTypedExportProfile(job.target.profile)) continue;
      const artifact = await app.db.execute<{ sha256: string; byte_size: string; state: string }>(sql`select sha256,byte_size,state from ofapi_typed_export_artifacts where export_job_id=${job.id}::uuid`);
      const cursor = job.cursor;
      const controlAction: "cancel" | "retry" | null = job.target.controlAction === "cancel" || job.target.controlAction === "retry" ? job.target.controlAction : null;
      const number = (value: unknown) => typeof value === "number" ? value : null;
      jobs.push({ jobId: job.id, pageId: job.pageId, profile: job.target.profile, state: job.state, rowVersion: job.rowVersion, reason: job.reasonCode, createdAt: job.createdAt.toISOString(),
        vendorExportId: typeof cursor?.vendorExportId === "string" ? cursor.vendorExportId : null, vendorStatus: typeof cursor?.vendorStatus === "string" ? cursor.vendorStatus : null,
        totalRows: number(cursor?.totalRows), deliveredRows: number(cursor?.rowsProcessed), creditCost: number(cursor?.creditCost), spentCredits: job.spentCredits,
        imported: artifact.rows[0]?.state === "imported", sha256: artifact.rows[0]?.sha256 ?? null, artifactBytes: artifact.rows[0] ? Number(artifact.rows[0].byte_size) : null, collectionJobId: String(job.target.collectionJobId), controlAction, sourceJobId: typeof job.target.sourceJobId === "string" ? job.target.sourceJobId : null });
    }
    return { jobs };
  });
  server.get("/api/v1/admin/ofapi/exports/:jobId/rows", { schema: ofapiExportRouteSchemas.ofapiTypedExportRows }, async request => {
    const principal = await requirePrincipal(request); requireDashboardUser(principal);
    const job = await requireTypedExportJob(app, request.params.jobId);
    if (!canAccessPage(principal, job.pageId)) throw new ForbiddenError();
    if (!isOfapiTypedExportProfile(job.target.profile)) throw new BadRequestError("Invalid profile");
    return { pageId: job.pageId, profile: job.target.profile, coverage: "item_presence" as const, rows: await listOfapiTypedExportRows(app.db, { jobId: job.id, ...request.query }) };
  });
  server.get("/api/v1/admin/ofapi/profile-visitors", { schema: ofapiExportRouteSchemas.ofapiProfileVisitorsGet }, async request => {
    const principal = await requirePrincipal(request); requireDashboardUser(principal);
    if (!canAccessPage(principal, request.query.pageId)) throw new ForbiddenError();
    const days = (Date.parse(request.query.to) - Date.parse(request.query.from)) / 86400000;
    if (days < 0 || days > 365) throw new BadRequestError("Choose a range of at most 366 days");
    return { pageId: request.query.pageId, days: await listOfapiProfileVisitorsDaily(app.db, request.query), note: "Account-day aggregates. Missing measurements are unknown. Visitor categories may overlap; duration units and equivalence of REST chart duration to CSV average duration are not verified." };
  });
}
