import { useQuery } from "@tanstack/react-query";
import { kernel } from "./sdk.js";
import type { OfapiAction } from "@agency_hub_core/contracts";
export const accountActions = {
  prepare: (id: string, command: OfapiAction) => kernel.ofapiActionPrepare({ body: { id, command } }),
  get: (id: string) => kernel.ofapiActionGet({ params: { id } }),
  dispatch: (id: string) => kernel.ofapiActionDispatch({ params: { id }, body: {} }),
  cancel: (id: string) => kernel.ofapiActionCancel({ params: { id }, body: {} }),
  repair: (id: string) => kernel.ofapiActionRepair({ params: { id }, body: {} }),
};
export function useOfapiActions(pageId: number | null) {
  return useQuery({ queryKey: ["admin", "ofapi-actions", pageId], enabled: pageId !== null,
    queryFn: () => kernel.ofapiActionList({ query: { pageId: pageId! } }), refetchInterval: 15000,
    meta: { suppressGlobalError: true } });
}
