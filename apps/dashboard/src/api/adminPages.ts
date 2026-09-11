import { useIsMutating, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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

export function useAdminModels(options: { suppressGlobalError?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "models"],
    meta: { suppressGlobalError: options.suppressGlobalError ?? false },
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
    mutationFn: async (updates: { slug: string; sortOrder: number }[]) => {
      const results = await Promise.allSettled(
        updates.map((update) =>
          kernel.adminUpdateModel({
            params: { modelSlug: update.slug },
            body: { sortOrder: update.sortOrder },
          }),
        ),
      );
      // A failed swap can still have a successful second write. Wait for both
      // before the caller refreshes the catalog to show the resulting order.
      const failure = results.find((result) => result.status === "rejected");
      if (failure) throw failure.reason;
      return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
    },
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

export function useAdminPages(options: { suppressGlobalError?: boolean } = {}) {
  return useQuery({
    queryKey: ["admin", "pages"],
    meta: { suppressGlobalError: options.suppressGlobalError ?? false },
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

export function useAdminVerifyPage(pageLabel: string, pageId: number) {
  const qc = useQueryClient();
  const mutationKey = ["admin", "verifyPage", pageId];
  // The request outlives filtered rows and settings-tab navigation. A new
  // observer must still show its pending state for this same page.
  const pendingCount = useIsMutating({ mutationKey });
  const mutation = useMutation({
    mutationKey,
    meta: { suppressGlobalError: true },
    mutationFn: () =>
      kernel.adminVerifyPage({ params: { pageLabel } }),
    onSuccess: () => invalidateAdminCatalog(qc),
  });
  return { ...mutation, isPending: mutation.isPending || pendingCount > 0 };
}
