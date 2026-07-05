import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { NotificationsDiscoverChatsBody, NotificationsSettingsUpdateBody } from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

export function useNotificationsSettings() {
  return useQuery({
    queryKey: ["notifications", "settings"],
    queryFn: () => kernel.notificationsSettings(),
  });
}

export function useUpdateNotificationsSettings() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: NotificationsSettingsUpdateBody) =>
      kernel.notificationsSettingsUpdate({ body }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "settings"] }),
  });
}

export function useSendTestMessage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.notificationsTestMessage(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "settings"] }),
  });
}

export function useDiscoverTelegramChats() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: NotificationsDiscoverChatsBody) =>
      kernel.notificationsDiscoverChats({ body }),
  });
}

export function useNotificationIncidents(params: {
  status?: string;
  kind?: string;
  pageLabel?: string;
  limit?: number;
  offset?: number;
} = {}) {
  return useQuery({
    queryKey: ["notifications", "incidents", params],
    queryFn: () => kernel.notificationsIncidents({
      query: params as Parameters<typeof kernel.notificationsIncidents>[0]["query"],
    }),
    refetchInterval: 30_000,
  });
}

export function useResolveIncident() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (incidentId: number) =>
      kernel.notificationsResolveIncident({ params: { incidentId } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "incidents"] }),
  });
}

export function useReportPreview() {
  return useQuery({
    queryKey: ["notifications", "reportPreview"],
    queryFn: () => kernel.notificationsReportPreview(),
    enabled: false,
  });
}

export function useSendReport() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => kernel.notificationsReportSend(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "reportHistory"] }),
  });
}

export function useReportHistory() {
  return useQuery({
    queryKey: ["notifications", "reportHistory"],
    queryFn: () => kernel.notificationsReportHistory(),
  });
}
