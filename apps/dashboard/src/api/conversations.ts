import { useQuery } from "@tanstack/react-query";
import type { PageConversationPreviewResponse } from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";
import { pathSegment } from "@/lib/path";

export function usePageConversationPreview(
  pageLabel: string,
  platformConversationId: string | null,
  params: { limit?: number } = {},
) {
  return useQuery({
    queryKey: ["pageConversationPreview", pageLabel, platformConversationId, params],
    queryFn: () =>
      api.get<PageConversationPreviewResponse>(
        `/api/v1/pages/${pathSegment(pageLabel)}/conversations/${pathSegment(platformConversationId!)}/preview${qs(params)}`,
      ),
    enabled: !!platformConversationId,
  });
}
