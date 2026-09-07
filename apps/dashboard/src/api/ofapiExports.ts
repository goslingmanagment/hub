import { useQuery } from "@tanstack/react-query";
import { kernel } from "./sdk.js";
export const ofapiExportActions = {
  control: (jobId: string, body: Parameters<typeof kernel.ofapiTypedExportControl>[0]["body"]) => kernel.ofapiTypedExportControl({ params: { jobId }, body }),
  refreshInventory: (body: Parameters<typeof kernel.ofapiExportInventoryRefresh>[0]["body"]) => kernel.ofapiExportInventoryRefresh({ body }),
  create: (body: Parameters<typeof kernel.ofapiTypedExportCreate>[0]["body"]) => kernel.ofapiTypedExportCreate({ body }),
  resume: (jobId: string, body: Parameters<typeof kernel.ofapiTypedExportResume>[0]["body"]) => kernel.ofapiTypedExportResume({ params: { jobId }, body }),
  approve: (jobId: string, body: Parameters<typeof kernel.ofapiTypedExportApprove>[0]["body"]) => kernel.ofapiTypedExportApprove({ params: { jobId }, body }),
  artifact: (jobId: string, body: Parameters<typeof kernel.ofapiTypedExportArtifact>[0]["body"]) => kernel.ofapiTypedExportArtifact({ params: { jobId }, body }),
};
export function useOfapiExportPages() { return useQuery({ queryKey: ["ofapi", "collection"], queryFn: () => kernel.ofapiCollectionGet({ query: {} }) }); }
export function useOfapiExports(pageId: number) { return useQuery({ queryKey: ["ofapi", "exports", pageId], enabled: pageId > 0, queryFn: () => kernel.ofapiTypedExportList({ query: { pageId } }), refetchInterval: 15000 }); }
export function useOfapiExportRows(jobId: string) { return useQuery({ queryKey: ["ofapi", "exportRows", jobId], enabled: Boolean(jobId), queryFn: () => kernel.ofapiTypedExportRows({ params: { jobId }, query: { offset: 0, limit: 100 } }) }); }
export function useOfapiVisitors(query: { pageId: number; from: string; to: string; source: "export" | "rest" }) { return useQuery({ queryKey: ["ofapi", "visitors", query], enabled: query.pageId > 0 && Boolean(query.from && query.to), queryFn: () => kernel.ofapiProfileVisitorsGet({ query }) }); }

export function useOfapiExportInventory(enabled: boolean) { return useQuery({ queryKey: ["ofapi", "exportInventory"], enabled, queryFn: () => kernel.ofapiExportInventoryGet() }); }
