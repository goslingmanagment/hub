import { useQuery } from "@tanstack/react-query";

import { kernel } from "./sdk.js";

export function usePageConversationPreview(
  pageLabel: string,
  platformConversationId: string | null,
  params: { limit?: number } = {},
) {
  return useQuery({
    queryKey: ["pageConversationPreview", pageLabel, platformConversationId, params],
    queryFn: () =>
      kernel.pageConversationPreview({
        params: { pageLabel, platformConversationId: platformConversationId! },
        query: params,
      }),
    enabled: !!platformConversationId,
  });
}
