import { queryOptions, useQuery, type QueryClient } from "@tanstack/react-query";
import { kernel } from "./sdk.js";
import { ofapiCollectionQueryOptions } from "./ofapiCollection.js";
export const ofapiExportActions = {
  control: (jobId: string, body: Parameters<typeof kernel.ofapiTypedExportControl>[0]["body"]) => kernel.ofapiTypedExportControl({ params: { jobId }, body }),
  refreshInventory: (body: Parameters<typeof kernel.ofapiExportInventoryRefresh>[0]["body"]) => kernel.ofapiExportInventoryRefresh({ body }),
  create: (body: Parameters<typeof kernel.ofapiTypedExportCreate>[0]["body"]) => kernel.ofapiTypedExportCreate({ body }),
  resume: (jobId: string, body: Parameters<typeof kernel.ofapiTypedExportResume>[0]["body"]) => kernel.ofapiTypedExportResume({ params: { jobId }, body }),
  approve: (jobId: string, body: Parameters<typeof kernel.ofapiTypedExportApprove>[0]["body"]) => kernel.ofapiTypedExportApprove({ params: { jobId }, body }),
  artifact: (jobId: string, body: Parameters<typeof kernel.ofapiTypedExportArtifact>[0]["body"]) => kernel.ofapiTypedExportArtifact({ params: { jobId }, body }),
};
export function useOfapiExportPages() { return useQuery(ofapiCollectionQueryOptions()); }
export function ofapiExportJobsQueryOptions(pageId: number) {
  return queryOptions({
    queryKey: ["ofapi", "exports", pageId],
    queryFn: () => kernel.ofapiTypedExportList({ query: { pageId } }),
  });
}
export async function readOfapiExportJobsForRecovery(queryClient: QueryClient, pageId: number) {
  const options = ofapiExportJobsQueryOptions(pageId);
  // refetch(cancelRefetch) may reuse an initial GET when no data is cached yet.
  await queryClient.cancelQueries({ queryKey: options.queryKey, exact: true });
  await queryClient.fetchQuery({ ...options, staleTime: 0 });
  return { pageId, dataUpdatedAt: queryClient.getQueryState(options.queryKey)!.dataUpdatedAt };
}
export function useOfapiExports(pageId: number) {
  return useQuery({ ...ofapiExportJobsQueryOptions(pageId), enabled: pageId > 0, refetchInterval: 15000 });
}
export function useOfapiExportRows(jobId: string) { return useQuery({ queryKey: ["ofapi", "exportRows", jobId], enabled: Boolean(jobId), queryFn: () => kernel.ofapiTypedExportRows({ params: { jobId }, query: { offset: 0, limit: 100 } }) }); }
export function useOfapiVisitors(query: { pageId: number; from: string; to: string; source: "export" | "rest" }) { return useQuery({ queryKey: ["ofapi", "visitors", query], enabled: query.pageId > 0 && Boolean(query.from && query.to), queryFn: () => kernel.ofapiProfileVisitorsGet({ query }) }); }

export function useOfapiExportInventory(enabled: boolean) { return useQuery({ queryKey: ["ofapi", "exportInventory"], enabled, queryFn: () => kernel.ofapiExportInventoryGet() }); }
