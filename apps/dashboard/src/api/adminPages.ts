import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import type {
  CreateModelBody,
  CreatePageBody,
  TestProxyBody,
  UpdateModelBody,
  UpdatePageBody,
  VerifyCredentialsBody,
} from "@agency_hub_core/contracts";

import { kernel } from "./sdk.js";

function invalidateAdminCatalog(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: ["admin", "models"] });
  qc.invalidateQueries({ queryKey: ["admin", "pages"] });
  // The serving catalog behind `usePages()` is the SAME fact under a different
  // key. It is prefetched at boot and stays fresh for 30 s, so a create /
  // rename / delete that only invalidated the admin key left Analytics
  // offering a page that no longer exists for up to half a minute.
  qc.invalidateQueries({ queryKey: ["pages"] });
  qc.invalidateQueries({ queryKey: ["admin", "connections"] });
  qc.invalidateQueries({ queryKey: ["admin", "users"] });
  qc.invalidateQueries({ queryKey: ["overview"] });
}

export function useAdminModels() {
  return useQuery({
    queryKey: ["admin", "models"],
    queryFn: () => kernel.adminModels(),
  });
}

export function useAdminCreateModel() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: CreateModelBody) =>
      kernel.adminCreateModel({ body }),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminUpdateModel(modelSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: UpdateModelBody) =>
      kernel.adminUpdateModel({ params: { modelSlug }, body }),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminReorderModels() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (updates: { slug: string; sortOrder: number }[]) =>
      Promise.all(
        updates.map((update) =>
          kernel.adminUpdateModel({
            params: { modelSlug: update.slug },
            body: { sortOrder: update.sortOrder },
          }),
        ),
      ),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminDeleteModel(modelSlug: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      kernel.adminDeleteModel({ params: { modelSlug } }),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminPages() {
  return useQuery({
    queryKey: ["admin", "pages"],
    queryFn: () => kernel.adminPages(),
  });
}

export function useAdminCreatePage() {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: CreatePageBody) =>
      kernel.adminCreatePage({ body }),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminUpdatePage(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: UpdatePageBody) =>
      kernel.adminUpdatePage({ params: { pageLabel }, body }),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminDeletePage(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      kernel.adminDeletePage({ params: { pageLabel } }),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}

export function useAdminVerifyCredentials() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: VerifyCredentialsBody) =>
      kernel.adminVerifyCredentials({ body }),
  });
}

export function useAdminTestProxy() {
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: (body: TestProxyBody) =>
      kernel.adminTestProxy({ body }),
  });
}

export function useAdminVerifyPage(pageLabel: string) {
  const qc = useQueryClient();
  return useMutation({
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      kernel.adminVerifyPage({ params: { pageLabel } }),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
}
