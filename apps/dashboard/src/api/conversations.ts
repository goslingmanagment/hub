import { useQuery } from "@tanstack/react-query";
import type { PageConversationPreviewResponse } from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";

export function usePageConversationPreview(
  pageLabel: string,
  platformConversationId: string | null,
  params: { limit?: number } = {},
) {
  return useQuery({
    queryKey: ["pageConversationPreview", pageLabel, platformConversationId, params],
    queryFn: () =>
      api.get<PageConversationPreviewResponse>(
        `/api/v1/pages/${pageLabel}/conversations/${platformConversationId}/preview${qs(params)}`,
      ),
    enabled: !!platformConversationId,
  });
}
