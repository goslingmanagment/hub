import { useQuery } from "@tanstack/react-query";
import { kernel } from "./sdk.js";
export function useAdminOfapiStoredReads(
  pageId: number | undefined,
  operation: string,
) {
  return useQuery({
    queryKey: ["ofapi-stored-reads", pageId, operation],
    queryFn: () =>
      kernel.ofapiReadCollectionsGet({
        query: {
          pageId: pageId!,
          limit: 25,
          ...(operation ? { operation } : {}),
        },
      }),
    enabled: pageId !== undefined,
    meta: { suppressGlobalError: true },
  });
}
