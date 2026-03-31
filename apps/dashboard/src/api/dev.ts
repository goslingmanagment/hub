import { useQuery } from "@tanstack/react-query";
import type { SyncRunDetailResponse } from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { qs } from "./utils.js";

export interface AdminLogItem {
  id: number | null;
  pageLabel: string | null;
  stream: string | null;
  severity: string;
  eventType: string | null;
  message: string | null;
  details: Record<string, unknown> | null;
  syncRunId: number | null;
  emittedAt: string | null;
}

export interface AdminQueueJob {
  id: string | number | null;
  name: string | null;
  state: string;
  createdOn: string | null;
  startedOn: string | null;
  completedOn: string | null;
  retryCount: number | null;
  data: unknown;
  output: unknown;
}

export interface AdminDbTableStat {
  table: string;
  rowEstimate: number | null;
  totalBytes: number | null;
  indexBytes: number | null;
}

export interface AdminDbMigration {
  id: number | null;
  hash: string | null;
  createdAt: string | null;
}

export interface AdminDbStatsResponse {
  tables: AdminDbTableStat[];
  migrations: AdminDbMigration[];
}

export interface AdminIncidentSummary {
  code: string;
  count: number;
  severity: string | null;
}

export interface AdminIncidentItem {
  id: number | null;
  pageLabel: string | null;
  stream: string | null;
  eventType: string | null;
  severity: string;
  message: string | null;
  details: Record<string, unknown> | null;
  syncRunId: number | null;
  emittedAt: string | null;
}

export interface AdminIncidentsResponse {
  summary: AdminIncidentSummary[];
  items: AdminIncidentItem[];
}

export function useAdminLogs(params: { severity?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["admin", "logs", params],
    queryFn: () => api.get<AdminLogItem[]>(`/api/v1/admin/logs${qs(params)}`),
    refetchInterval: 10_000,
  });
}

export function useAdminSyncRunDetail(runId: number) {
  return useQuery({
    queryKey: ["admin", "syncRunDetail", runId],
    queryFn: () => api.get<SyncRunDetailResponse>(`/api/v1/admin/sync/runs/${runId}`),
    enabled: runId > 0,
  });
}

export function useAdminQueueJobs(params: { state?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["admin", "queue", "jobs", params],
    queryFn: () => api.get<AdminQueueJob[]>(`/api/v1/admin/queue/jobs${qs(params)}`),
    refetchInterval: 10_000,
  });
}

export function useAdminDbStats() {
  return useQuery({
    queryKey: ["admin", "db", "stats"],
    queryFn: () => api.get<AdminDbStatsResponse>("/api/v1/admin/db/stats"),
  });
}

export function useAdminIncidents(params: { severity?: string; code?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ["admin", "incidents", params],
    queryFn: () => api.get<AdminIncidentsResponse>(`/api/v1/admin/incidents${qs(params)}`),
    refetchInterval: 30_000,
  });
}

