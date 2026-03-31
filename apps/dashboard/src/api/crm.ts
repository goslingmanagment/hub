import { useQuery } from "@tanstack/react-query";
import type {
  CrmConversationPreviewResponse,
  CrmReactivationResponse,
  CrmRetentionResponse,
  CrmSummaryResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";

export function useCrmSummary(
  pageLabel: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["crmSummary", pageLabel],
    queryFn: () => api.get<CrmSummaryResponse>(`/api/v1/pages/${pageLabel}/crm/summary`),
    enabled: options.enabled ?? true,
  });
}

export function useCrmRetention(
  pageLabel: string,
  params: {
    limit?: number;
    offset?: number;
    query?: string;
    touchpoint?: string[];
    autoRenew?: boolean;
    unreadOnly?: boolean;
    showHandled?: boolean;
    sortBy?: string;
    sortDir?: string;
  } = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["crmRetention", pageLabel, params],
    queryFn: () => api.get<CrmRetentionResponse>(`/api/v1/pages/${pageLabel}/crm/retention${qs(params)}`),
    placeholderData: (previousData) => previousData,
    enabled: options.enabled ?? true,
  });
}

export function useCrmReactivation(
  pageLabel: string,
  params: {
    limit?: number;
    offset?: number;
    query?: string;
    minSpendUsd?: number;
    minSilenceDays?: number;
    unreadOnly?: boolean;
    noDmHistoryOnly?: boolean;
    hideDeleted?: boolean;
    subscriberState?: string;
    sortBy?: string;
    sortDir?: string;
  } = {},
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: ["crmReactivation", pageLabel, params],
    queryFn: () => api.get<CrmReactivationResponse>(`/api/v1/pages/${pageLabel}/crm/reactivation${qs(params)}`),
    placeholderData: (previousData) => previousData,
    enabled: options.enabled ?? true,
  });
}

export function useCrmConversationPreview(
  pageLabel: string,
  platformConversationId: string | null,
  params: { limit?: number } = {},
) {
  return useQuery({
    queryKey: ["crmPreview", pageLabel, platformConversationId, params],
    queryFn: () =>
      api.get<CrmConversationPreviewResponse>(
        `/api/v1/pages/${pageLabel}/crm/conversations/${platformConversationId}/preview${qs(params)}`,
      ),
    enabled: !!platformConversationId,
  });
}

