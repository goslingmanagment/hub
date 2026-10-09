import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { kernel } from "./sdk.js";
import { OFAPI_COLLECTION_QUERY_KEY, ofapiCollectionQueryOptions } from "./ofapiCollection.js";

export { OFAPI_COLLECTION_QUERY_KEY } from "./ofapiCollection.js";

export type OfapiCollectionSnapshot = Awaited<ReturnType<typeof kernel.ofapiCollectionGet>>;
export type OfapiCollectionPreview = Awaited<ReturnType<typeof kernel.ofapiCollectionPreview>>;
export type OfapiCollectionChangeBody = NonNullable<Parameters<typeof kernel.ofapiCollectionApply>[0]>["body"];
export type OfapiCollectionSettings = OfapiCollectionChangeBody["changes"][number];
export type OfapiCollectionJobBody = NonNullable<Parameters<typeof kernel.ofapiCollectionJobCreate>[0]>["body"];
export type OfapiCollectionCategory = OfapiCollectionSettings["category"];
export type OfapiCollectionMode = OfapiCollectionSettings["mode"];
export type OfapiCollectionPolicy = OfapiCollectionSnapshot["policies"][number];
export type OfapiCollectionPolicySource = OfapiCollectionPolicy["source"];
export type OfapiCollectionPolicyState = OfapiCollectionPolicy["state"];
export type OfapiCollectionCatalogEntry = OfapiCollectionSnapshot["catalog"][number];
export type OfapiCollectionPage = OfapiCollectionSnapshot["pages"][number];
export type OfapiCollectionJob = OfapiCollectionSnapshot["jobs"][number];
export type OfapiCollectionScheduleHealth = OfapiCollectionPolicy["scheduleHealth"];
export type OfapiCollectionRun = NonNullable<OfapiCollectionScheduleHealth["lastRun"]>;
export type OfapiCollectionJobStateFilter = NonNullable<NonNullable<Parameters<typeof kernel.ofapiCollectionGet>[0]>["query"]>["jobState"];
export type OfapiCollectionAuditRow = OfapiCollectionSnapshot["audit"][number];
export type OfapiCollectionApplyResult = Awaited<ReturnType<typeof kernel.ofapiCollectionApply>>;
export type OfapiCollectionJobCreateResult = Awaited<ReturnType<typeof kernel.ofapiCollectionJobCreate>>;

/** Read-only: the GET reads retained local rows only, never the vendor. */
export function useAdminOfapiCollection() {
  return useQuery({
    ...ofapiCollectionQueryOptions(),
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
  });
}

/** The job list narrowed to one state (or every unfinished job), so a run
 *  past the snapshot's hundred rows stays reachable. Shares the collection
 *  key prefix: every mutation's invalidation refreshes it too. */
export function useAdminOfapiCollectionJobs(jobState: Exclude<OfapiCollectionJobStateFilter, undefined> | null) {
  return useQuery({
    queryKey: [...OFAPI_COLLECTION_QUERY_KEY, "jobs", jobState],
    queryFn: () => kernel.ofapiCollectionGet({ query: { jobState: jobState! } }),
    enabled: jobState !== null,
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
    meta: { suppressGlobalError: true },
  });
}

export function useOfapiCollectionPreview() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: OfapiCollectionChangeBody) =>
      kernel.ofapiCollectionPreview({ body }),
    // A failed preview (409 revision conflict, 400 validation) means the
    // screen's revision or catalog is stale — refresh so the compare view and
    // the retry use the server's current truth.
    onError: () => qc.invalidateQueries({ queryKey: OFAPI_COLLECTION_QUERY_KEY }),
  });
}

export function useOfapiCollectionApply() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: OfapiCollectionChangeBody) =>
      kernel.ofapiCollectionApply({ body }),
    // Refetch after success AND failure: success needs the readback
    // (snapshot.revision reaching the applied one), a 409 needs the new revision.
    onSettled: () => qc.invalidateQueries({ queryKey: OFAPI_COLLECTION_QUERY_KEY }),
  });
}

export function useOfapiCollectionJobCreate() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: OfapiCollectionJobBody) =>
      kernel.ofapiCollectionJobCreate({ body }),
    onSettled: () => qc.invalidateQueries({ queryKey: OFAPI_COLLECTION_QUERY_KEY }),
  });
}

/** Existing owner-session read of the single global webhook registration
 *  (DB-backed, no vendor call). Rendered read-only on the Collection screen;
 *  per-event-group controls wait for their own S2/S3 API. */
export function useAdminOfapiWebhookStatus() {
  return useQuery({
    queryKey: ["admin", "ofapi-webhook", "status"],
    queryFn: () => kernel.adminOfapiWebhookStatus(),
    refetchInterval: 30_000,
    meta: { suppressGlobalError: true },
  });
}

export function useOfapiCollectionJobResume() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: ({ id, expectedRevision }: { id: string; expectedRevision: number }) => kernel.ofapiCollectionJobResume({ params: { id }, body: { expectedRevision } }),
    onSettled: () => qc.invalidateQueries({ queryKey: OFAPI_COLLECTION_QUERY_KEY }),
  });
}

export function useOfapiCollectionJobFinishIncomplete() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (input: Parameters<typeof kernel.ofapiCollectionJobFinishIncomplete>[0]) => kernel.ofapiCollectionJobFinishIncomplete(input),
    onSettled: () => qc.invalidateQueries({ queryKey: OFAPI_COLLECTION_QUERY_KEY }),
  });
}
