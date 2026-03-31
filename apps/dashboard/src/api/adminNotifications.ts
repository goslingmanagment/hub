import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  NotificationsIncidentsResponse,
  NotificationsReportHistoryResponse,
  NotificationsReportPreviewResponse,
  NotificationsReportSendResponse,
  NotificationsSettingsResponse,
  NotificationsSettingsUpdateBody,
  NotificationsTestMessageResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";

export function useNotificationsSettings() {
  return useQuery({
    queryKey: ["notifications", "settings"],
    queryFn: () => api.get<NotificationsSettingsResponse>("/api/v1/admin/notifications/settings"),
  });
}

export function useUpdateNotificationsSettings() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: NotificationsSettingsUpdateBody) =>
      api.patch<NotificationsSettingsResponse>("/api/v1/admin/notifications/settings", body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "settings"] }),
  });
}

export function useSendTestMessage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => api.post<NotificationsTestMessageResponse>("/api/v1/admin/notifications/test"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "settings"] }),
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
    queryFn: () => api.get<NotificationsIncidentsResponse>(
      `/api/v1/admin/notifications/incidents${qs(params)}`,
    ),
    refetchInterval: 30_000,
  });
}

export function useResolveIncident() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (incidentId: number) =>
      api.post(`/api/v1/admin/notifications/incidents/${incidentId}/resolve`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "incidents"] }),
  });
}

export function useReportPreview() {
  return useQuery({
    queryKey: ["notifications", "reportPreview"],
    queryFn: () => api.get<NotificationsReportPreviewResponse>("/api/v1/admin/notifications/reports/preview"),
    enabled: false,
  });
}

export function useSendReport() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () => api.post<NotificationsReportSendResponse>("/api/v1/admin/notifications/reports/send"),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["notifications", "reportHistory"] }),
  });
}

export function useReportHistory() {
  return useQuery({
    queryKey: ["notifications", "reportHistory"],
    queryFn: () => api.get<NotificationsReportHistoryResponse>("/api/v1/admin/notifications/reports/history"),
  });
}

