import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  AdminCreatePageResponse,
  AdminUpdatePageResponse,
  AssignedPage,
  CreateModelBody,
  CreateModelResponse,
  CreatePageBody,
  DeletedResponse,
  ModelListItem,
  TestProxyBody,
  TestProxyResponse,
  UpdateModelBody,
  UpdatePageBody,
  VerifyCredentialsBody,
  VerifyCredentialsResponse,
  VerifyPageResponse,
} from "@agency_hub_core/contracts";
import { api } from "./client.js";
import { pathSegment } from "@/lib/path";

function invalidateAdminCatalog(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["admin", "models"] });
  qc.invalidateQueries({ queryKey: ["admin", "pages"] });
  qc.invalidateQueries({ queryKey: ["admin", "connections"] });
  qc.invalidateQueries({ queryKey: ["admin", "users"] });
  qc.invalidateQueries({ queryKey: ["overview"] });
}

export function useAdminModels() {
  return useQuery({
    queryKey: ["admin", "models"],
    queryFn: () => api.get<ModelListItem[]>("/api/v1/admin/models"),
  });
}

export function useAdminCreateModel() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: CreateModelBody) =>
      api.post<CreateModelResponse>("/api/v1/admin/models", body),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminUpdateModel(modelSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: UpdateModelBody) =>
      api.patch<CreateModelResponse>(`/api/v1/admin/models/${pathSegment(modelSlug)}`, body),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminDeleteModel(modelSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      api.del<DeletedResponse>(`/api/v1/admin/models/${pathSegment(modelSlug)}`),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminPages() {
  return useQuery({
    queryKey: ["admin", "pages"],
    queryFn: () => api.get<AssignedPage[]>("/api/v1/admin/pages"),
  });
}

export function useAdminCreatePage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: CreatePageBody) =>
      api.post<AdminCreatePageResponse>("/api/v1/admin/pages", body),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminUpdatePage(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: UpdatePageBody) =>
      api.patch<AdminUpdatePageResponse>(`/api/v1/admin/pages/${pathSegment(pageLabel)}`, body),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminDeletePage(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      api.del<DeletedResponse>(`/api/v1/admin/pages/${pathSegment(pageLabel)}`),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminVerifyCredentials() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: VerifyCredentialsBody) =>
      api.post<VerifyCredentialsResponse>("/api/v1/admin/credentials/verify", body),
  });
}

export function useAdminTestProxy() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: TestProxyBody) =>
      api.post<TestProxyResponse>("/api/v1/admin/proxy/test", body),
  });
}

export function useAdminVerifyPage(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      api.post<VerifyPageResponse>(`/api/v1/admin/pages/${pathSegment(pageLabel)}/verify`),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}
