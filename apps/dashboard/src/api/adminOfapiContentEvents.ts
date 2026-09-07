import { useQuery } from "@tanstack/react-query";
import { kernel } from "./sdk.js";
export function useAdminOfapiContentEvents(pageId: number | undefined) {
  return useQuery({
    queryKey: ["ofapi-content-events", pageId],
    queryFn: () =>
      kernel.ofapiContentEventsGet({ query: { pageId: pageId!, limit: 50 } }),
    enabled: pageId !== undefined,
    meta: { suppressGlobalError: true },
  });
}
