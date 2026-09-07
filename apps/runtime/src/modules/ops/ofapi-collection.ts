import { OFAPI_COLLECTION_REGISTRY } from "@agency_hub_core/shared";
import { ofapiCollectionRouteSchemas } from "@agency_hub_core/contracts";
import { applyOfapiCollectionPolicy, createOfapiCollectionJob, finishIncompleteOfapiCollectionJob, getOfapiCollectionSnapshot, OfapiCollectionPolicyError, previewOfapiCollectionPolicy, resumeOfapiCollectionJob } from "@agency_hub_core/db";
import { canAccessPage, requireDashboardUser, requireOwner } from "../../services/auth.ts";
import { BadRequestError, ConflictError, ForbiddenError } from "../../services/errors.ts";
import type { ApiModuleContext, ApiServer } from "../context.ts";

async function policyResult<T>(action: () => Promise<T>): Promise<T> {
  try { return await action(); } catch (error) {
    if (!(error instanceof OfapiCollectionPolicyError)) throw error;
    if (error.reason === "revision_conflict") throw new ConflictError("Collection policy changed in another session. Reload and preview again.");
    if (error.reason === "job_not_finishable") throw new ConflictError("Only an idle paused scheduled read can be finished. Reload the collection status.");
    throw new BadRequestError(error.message);
  }
}
export function registerOfapiCollectionRoutes(server: ApiServer, ctx: ApiModuleContext) {
  const { appContext: app, auth: { requirePrincipal }, boss } = ctx;
  server.get("/api/v1/admin/ofapi/collection", { schema: ofapiCollectionRouteSchemas.ofapiCollectionGet }, async request => {
    const principal = await requirePrincipal(request); requireDashboardUser(principal);
    if (request.query.pageId !== undefined && !canAccessPage(principal, request.query.pageId)) throw new ForbiddenError();
    return getOfapiCollectionSnapshot(app.db, principal.user.role === "owner" ? null : principal.assignedPageIds, request.query.pageId);
  });
  server.post("/api/v1/admin/ofapi/collection/preview", { schema: ofapiCollectionRouteSchemas.ofapiCollectionPreview }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return policyResult(() => previewOfapiCollectionPolicy(app.db, request.body));
  });
  server.post("/api/v1/admin/ofapi/collection/apply", { schema: ofapiCollectionRouteSchemas.ofapiCollectionApply }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    return policyResult(() => applyOfapiCollectionPolicy(app.db, request.body, principal.user.id));
  });
  server.post("/api/v1/admin/ofapi/collection/jobs", { schema: ofapiCollectionRouteSchemas.ofapiCollectionJobCreate }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    if (request.body.category === "vault_files") throw new BadRequestError("Use /ofapi-media to upload an owned source with a frozen preview and explicit approval.");
    if (!OFAPI_COLLECTION_REGISTRY.find(entry => entry.id === request.body.category)?.supportsOneOff) throw new BadRequestError("This baseline category uses its existing collector. Configure its collection policy; generic one-off jobs are unavailable.");
    const job = await policyResult(() => createOfapiCollectionJob(app.db, request.body, principal.user.id));
    // Durable queued rows are also swept; a lost pg-boss wakeup never loses approval.
    await boss?.send("ofapi.collection.run", { jobId: job.id }, { singletonKey: job.id, retryLimit: 0 });
    return job;
  });
  server.post("/api/v1/admin/ofapi/collection/jobs/:id/resume", { schema: ofapiCollectionRouteSchemas.ofapiCollectionJobResume }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    const job = await policyResult(() => resumeOfapiCollectionJob(app.db, request.params.id, request.body.expectedRevision, principal.user.id));
    await boss?.send("ofapi.collection.run", { jobId: job.id }, { singletonKey: job.id, retryLimit: 0 });
    return job;
  });
  server.post("/api/v1/admin/ofapi/collection/jobs/:id/finish-incomplete", { schema: ofapiCollectionRouteSchemas.ofapiCollectionJobFinishIncomplete }, async request => {
    const principal = await requirePrincipal(request); requireOwner(principal);
    if (!canAccessPage(principal, request.body.pageId)) throw new ForbiddenError();
    // Local lifecycle action only: do not enqueue work or reconcile an uncertain charge.
    return policyResult(() => finishIncompleteOfapiCollectionJob(app.db, { id: request.params.id, ...request.body }, principal.user.id));
  });
}
